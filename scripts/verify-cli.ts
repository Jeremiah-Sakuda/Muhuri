/**
 * Muhuri standalone verifier — CLI.
 *
 * Runs entirely offline with ZERO AWS credentials. Hand it a proof bundle and
 * it tells you, by math alone, whether the sealed auction is authentic.
 *
 *   npm run verify -- <proof-bundle.json>   verify a downloaded bundle
 *   npm run verify -- --demo                seal a local auction and verify it
 *   npm run verify -- --demo --tamper       show a forgery being caught
 *
 * A judge can run `npm run verify -- --demo` with no cloud setup whatsoever.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { computeCommit, randomNonce } from "../src/lib/crypto";
import { MemoryStore } from "../src/lib/store/MemoryStore";
import { buildProofBundle } from "../src/lib/proof";
import { verifyProofBundle, type ProofBundle } from "../src/lib/verifier";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

function short(hex: string): string {
  return hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-10)}` : hex;
}

async function demoBundle(tamper: boolean): Promise<ProofBundle> {
  const store = new MemoryStore();
  const meta = await store.createAuction({ title: "Demo — bridge maintenance tender" });
  const id = meta.auctionId;
  const inputs = [
    { bidderId: "acme-infra", amount: "2480000" },
    { bidderId: "globex-build", amount: "2399000" },
    { bidderId: "initech-civil", amount: "2515000" },
  ];
  const reveals: { bidId: string; amount: string; nonce: string }[] = [];
  for (const i of inputs) {
    const nonce = randomNonce();
    const bidId = randomUUID();
    await store.appendCommit(id, {
      bidId,
      bidderId: i.bidderId,
      commit: computeCommit(i.amount, nonce, i.bidderId),
    });
    reveals.push({ bidId, amount: i.amount, nonce });
  }
  await store.seal(id, meta.sealToken);
  for (const r of reveals) await store.reveal(id, r);
  const bundle = await buildProofBundle(store, id);

  if (tamper) {
    // The operator rewrites the winning bid after the fact.
    bundle.bids[1].amount = "1000000";
  }
  return bundle;
}

function loadBundle(path: string): ProofBundle {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ProofBundle;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const tamper = args.includes("--tamper");
  const file = args.find((a) => !a.startsWith("--"));

  if (!demo && !file) {
    console.error(
      `${C.bold}Muhuri verifier${C.reset}\n` +
        `usage:\n` +
        `  npm run verify -- <proof-bundle.json>\n` +
        `  npm run verify -- --demo [--tamper]\n`,
    );
    process.exit(2);
  }

  const bundle = demo ? await demoBundle(tamper) : loadBundle(file!);

  console.log(`\n${C.bold}Muhuri — offline proof verification${C.reset}`);
  console.log(`${C.dim}no AWS credentials · no database · pure recomputation${C.reset}\n`);
  const wormLabel =
    bundle.witness.worm.kind === "s3-object-lock" ? "S3 Object Lock" : "in-memory WORM";
  console.log(`  auction        ${C.cyan}${bundle.auctionId}${C.reset}`);
  console.log(`  sealed at      ${bundle.witness.statement.sealedAt} ${C.dim}(operator-asserted)${C.reset}`);
  console.log(`  witnessed root ${C.dim}${short(bundle.witness.statement.merkleRoot)}${C.reset}`);
  console.log(
    `  witness        ${wormLabel} (${bundle.witness.worm.mode}) + ${bundle.witness.tsa.authority}`,
  );
  console.log("");

  const result = verifyProofBundle(bundle);

  for (const check of result.checks) {
    const mark = check.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${mark} ${check.label} ${C.dim}— ${check.detail}${C.reset}`);
  }
  console.log("");

  if (result.valid) {
    console.log(
      `  ${C.green}${C.bold}VALID${C.reset} — this sealed set is authentic: ` +
        `the order and contents match the externally-witnessed root.\n`,
    );
    process.exit(0);
  } else {
    console.log(`  ${C.red}${C.bold}INVALID${C.reset} — the proof does not hold:`);
    for (const reason of result.reasons) console.log(`     ${C.red}•${C.reset} ${reason}`);
    if (result.badReveals.length) {
      for (const bad of result.badReveals) {
        console.log(`     ${C.yellow}•${C.reset} bid seq ${bad.seq}: ${bad.reason}`);
      }
    }
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${C.red}verifier error:${C.reset}`, err instanceof Error ? err.message : err);
  process.exit(2);
});
