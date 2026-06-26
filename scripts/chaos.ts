/**
 * Chaos / attack harness — proves the marquee invariant under fire.
 *
 *   npm run chaos                 # against the in-memory backend
 *   MUHURI_BACKEND=dynamo … npm run chaos   # against real DynamoDB
 *
 * Six attacks, each printing a green PASS:
 *   1. late-insert    a valid bid after seal is rejected by the condition
 *   2. tamper         editing a sealed bid breaks the witnessed root
 *   3. reorder        permuting bids breaks the witnessed root
 *   4. bad-reveal     a reveal that doesn't open its commit is flagged
 *   5. witness-overwrite   the WORM witness refuses mutation
 *   6. concurrent seal + flood   exactly one seal wins; the root is consistent
 */
import { randomUUID } from "node:crypto";
import { computeCommit, randomNonce } from "../src/lib/crypto";
import { getStore } from "../src/lib/store";
import { ConditionalCheckError, WitnessImmutableError } from "../src/lib/errors";
import { buildProofBundle } from "../src/lib/proof";
import { verifyProofBundle } from "../src/lib/verifier";
import type { LedgerStore } from "../src/lib/store/LedgerStore";

const G = "\x1b[32m";
const R = "\x1b[31m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passes = 0;
let failures = 0;
function pass(name: string, detail = "") {
  passes++;
  console.log(`${G}PASS${X}  ${name}${detail ? `  ${D}${detail}${X}` : ""}`);
}
function fail(name: string, detail: string) {
  failures++;
  console.log(`${R}FAIL${X}  ${name}  ${detail}`);
}
function assert(cond: boolean, name: string, detail = "") {
  if (cond) pass(name, detail);
  else fail(name, detail || "assertion failed");
}

type Secret = { bidId: string; bidderId: string; amount: string; nonce: string };

async function seedOpen(
  store: LedgerStore,
  title: string,
  bids: { bidderId: string; amount: string }[],
): Promise<{ auctionId: string; sealToken: string; secrets: Secret[] }> {
  const meta = await store.createAuction({ title });
  const secrets: Secret[] = [];
  for (const b of bids) {
    const nonce = randomNonce();
    const bidId = randomUUID();
    await store.appendCommit(meta.auctionId, {
      bidId,
      bidderId: b.bidderId,
      commit: computeCommit(b.amount, nonce, b.bidderId),
    });
    secrets.push({ bidId, bidderId: b.bidderId, amount: b.amount, nonce });
  }
  return { auctionId: meta.auctionId, sealToken: meta.sealToken, secrets };
}

const SAMPLE = [
  { bidderId: "Acme", amount: "1450000" },
  { bidderId: "Globex", amount: "1399000" },
  { bidderId: "Initech", amount: "1502500" },
];

async function revealAll(store: LedgerStore, auctionId: string, secrets: Secret[]) {
  for (const s of secrets) {
    await store.reveal(auctionId, { bidId: s.bidId, amount: s.amount, nonce: s.nonce });
  }
}

async function lateInsert(store: LedgerStore) {
  const { auctionId, sealToken } = await seedOpen(store, "late-insert", SAMPLE);
  const close = await store.seal(auctionId, sealToken);
  let rejected = false;
  try {
    await store.appendCommit(auctionId, {
      bidId: randomUUID(),
      bidderId: "Latecomer",
      commit: computeCommit("9999999", randomNonce(), "Latecomer"),
    });
  } catch (err) {
    rejected = err instanceof ConditionalCheckError && err.reason === "SESSION_CLOSED";
  }
  const after = await store.getCloseRecord(auctionId);
  assert(rejected, "1. late-insert rejected by ConditionExpression");
  assert(
    after?.merkleRoot === close.merkleRoot && after?.count === close.count,
    "   close-record + witnessed root unchanged",
    `root ${close.merkleRoot.slice(0, 10)}…`,
  );
}

async function tamper(store: LedgerStore) {
  const { auctionId, sealToken, secrets } = await seedOpen(store, "tamper", SAMPLE);
  await store.seal(auctionId, sealToken);
  await revealAll(store, auctionId, secrets);
  const bundle = await buildProofBundle(store, auctionId);
  // Operator edits a sealed bid and recomputes its commit to stay consistent.
  bundle.bids[0].amount = "1";
  bundle.bids[0].commit = computeCommit("1", bundle.bids[0].nonce!, bundle.bids[0].bidderId);
  const result = verifyProofBundle(bundle);
  assert(!result.valid && !result.rootMatches, "2. tamper → recomputed root ≠ witnessed root");
}

async function reorder(store: LedgerStore) {
  const { auctionId, sealToken, secrets } = await seedOpen(store, "reorder", SAMPLE);
  await store.seal(auctionId, sealToken);
  await revealAll(store, auctionId, secrets);
  const bundle = await buildProofBundle(store, auctionId);
  const a = { ...bundle.bids[1], seq: 0 };
  const b = { ...bundle.bids[0], seq: 1 };
  bundle.bids[0] = a;
  bundle.bids[1] = b;
  const result = verifyProofBundle(bundle);
  assert(
    !result.valid && !result.rootMatches && result.badReveals.length === 0,
    "3. reorder → root mismatch (order is baked into the root)",
  );
}

async function badReveal(store: LedgerStore) {
  const { auctionId, sealToken, secrets } = await seedOpen(store, "bad-reveal", SAMPLE);
  await store.seal(auctionId, sealToken);
  await revealAll(store, auctionId, secrets);
  const bundle = await buildProofBundle(store, auctionId);
  // Reveal a different amount without touching the sealed commit.
  bundle.bids[1].amount = "777";
  const result = verifyProofBundle(bundle);
  assert(
    !result.valid && result.badReveals.length === 1 && result.badReveals[0].seq === 1,
    "4. bad-reveal flagged before the root check",
  );
}

async function witnessOverwrite(store: LedgerStore) {
  const { auctionId, sealToken } = await seedOpen(store, "witness-overwrite", SAMPLE);
  await store.seal(auctionId, sealToken);
  let refused = false;
  try {
    await store.attemptWitnessOverwrite(auctionId);
  } catch (err) {
    refused = err instanceof WitnessImmutableError;
  }
  assert(refused, "5. witness overwrite refused by WORM (COMPLIANCE)");
}

async function concurrentSealAndFlood(store: LedgerStore) {
  const meta = await store.createAuction({ title: "concurrent seal + flood" });
  const id = meta.auctionId;
  // Pre-seed a few bids so the auction isn't empty.
  const secrets: Secret[] = [];
  for (let i = 0; i < 5; i++) {
    const nonce = randomNonce();
    const bidId = randomUUID();
    const bidderId = `early-${i}`;
    await store.appendCommit(id, { bidId, bidderId, commit: computeCommit(String(1000 + i), nonce, bidderId) });
    secrets.push({ bidId, bidderId, amount: String(1000 + i), nonce });
  }

  // Fire a flood of appends concurrently with three seal attempts (same token).
  const floods = Array.from({ length: 40 }, (_, i) => async () => {
    const nonce = randomNonce();
    const bidId = randomUUID();
    const bidderId = `flood-${i}`;
    try {
      await store.appendCommit(id, { bidId, bidderId, commit: computeCommit(String(i), nonce, bidderId) });
      return { ok: true as const, secret: { bidId, bidderId, amount: String(i), nonce } };
    } catch {
      return { ok: false as const };
    }
  });
  const seals = Array.from({ length: 3 }, () => () => store.seal(id, meta.sealToken));

  const results = await Promise.allSettled([...floods.map((f) => f()), ...seals.map((s) => s())]);

  const sealResults = results.slice(40);
  const sealedOk = sealResults.filter((r) => r.status === "fulfilled");
  const roots = new Set(
    sealedOk.map((r) => (r as PromiseFulfilledResult<{ merkleRoot: string }>).value.merkleRoot),
  );
  assert(sealedOk.length === 3 && roots.size === 1, "6. concurrent seals agree (exactly one seal, idempotent)");

  // Appends that made it in before the winning seal are revealable; the rest
  // were rejected. The sealed count must equal the bids that won the race.
  const floodWins = results
    .slice(0, 40)
    .filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok)
    .map((r) => (r as PromiseFulfilledResult<{ ok: true; secret: Secret }>).value.secret);
  const allWinners = [...secrets, ...floodWins];

  const close = await store.getCloseRecord(id);
  assert(close?.count === allWinners.length, "   sealed count == bids that won the race", `${close?.count} bids`);

  await revealAll(store, id, allWinners);
  const bundle = await buildProofBundle(store, id);
  const verified = verifyProofBundle(bundle);
  assert(verified.valid, "   witnessed root matches exactly the bids that made it in");

  // Any append after the winning seal is rejected.
  let postRejected = false;
  try {
    await store.appendCommit(id, { bidId: randomUUID(), bidderId: "after", commit: "a".repeat(64) });
  } catch (err) {
    postRejected = err instanceof ConditionalCheckError;
  }
  assert(postRejected, "   post-seal append rejected");
}

async function main() {
  const store = getStore();
  console.log(`\n${D}Muhuri chaos harness — backend: ${store.backend}${X}\n`);
  await lateInsert(store);
  await tamper(store);
  await reorder(store);
  await badReveal(store);
  await witnessOverwrite(store);
  await concurrentSealAndFlood(store);
  console.log(
    `\n${failures === 0 ? G : R}${passes} passed, ${failures} failed${X} — the invariant ${
      failures === 0 ? "held under every attack." : "was violated."
    }\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${R}chaos harness crashed:${X}`, err);
  process.exit(1);
});
