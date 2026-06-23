import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { computeCommit, finalChainHead, merkleRoot, randomNonce } from "@/lib/crypto";
import { WitnessImmutableError } from "@/lib/errors";
import { MemoryStore } from "@/lib/store/MemoryStore";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import type { WormWitness } from "@/lib/store/LedgerStore";
import { buildProofBundle } from "@/lib/proof";
import { verifyProofBundle, type ProofBundle } from "@/lib/verifier";

/** Seal a small auction and return a fully-revealed, honest proof bundle. */
async function honestBundle(): Promise<ProofBundle> {
  const store = new MemoryStore();
  const meta = await store.createAuction({ title: "Highway resurfacing tender" });
  const id = meta.auctionId;
  const inputs = [
    { bidderId: "acme", amount: "1450000" },
    { bidderId: "globex", amount: "1399000" },
    { bidderId: "initech", amount: "1502500" },
    { bidderId: "umbrella", amount: "1410000" },
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
  return buildProofBundle(store, id);
}

const clone = (b: ProofBundle): ProofBundle => structuredClone(b);

describe("offline verifier", () => {
  let valid: ProofBundle;
  beforeAll(async () => {
    valid = await honestBundle();
  });

  it("happy path: an honest, fully-revealed seal verifies", () => {
    const r = verifyProofBundle(valid);
    expect(r.valid).toBe(true);
    expect(r.rootMatches).toBe(true);
    expect(r.chainMatches).toBe(true);
    expect(r.tsaValid).toBe(true);
    expect(r.countMatches).toBe(true);
    expect(r.badReveals).toHaveLength(0);
    expect(r.recomputedRoot).toBe(r.witnessedRoot);
  });

  it("tamper: editing a stored commit breaks the root", () => {
    const b = clone(valid);
    b.bids[2].commit = computeCommit("1", "evil", b.bids[2].bidderId);
    const r = verifyProofBundle(b);
    expect(r.valid).toBe(false);
    expect(r.rootMatches).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Merkle root/i);
  });

  it("reorder: moving a bid to another position breaks the root", () => {
    const b = clone(valid);
    const a0 = { ...b.bids[1], seq: 0 };
    const a1 = { ...b.bids[0], seq: 1 };
    b.bids[0] = a0;
    b.bids[1] = a1;
    const r = verifyProofBundle(b);
    expect(r.valid).toBe(false);
    expect(r.rootMatches).toBe(false);
    // Reveals still open their commitments — only the ORDER was attacked.
    expect(r.badReveals).toHaveLength(0);
  });

  it("bad reveal: an amount that doesn't open the commit is flagged first", () => {
    const b = clone(valid);
    b.bids[1].amount = "9999999"; // different from what was committed
    const r = verifyProofBundle(b);
    expect(r.valid).toBe(false);
    expect(r.badReveals).toHaveLength(1);
    expect(r.badReveals[0].seq).toBe(1);
  });

  it("the external witness is load-bearing: a fully self-consistent forgery still fails", () => {
    // The operator edits a bid AND rebuilds a matching root in the seal they
    // present — internally consistent. But the independent timestamp authority
    // signed the ORIGINAL root, so the forgery cannot reproduce a valid
    // signature. Caught by the witness, not by the operator's own data.
    const b = clone(valid);
    b.bids[0].amount = "999999";
    b.bids[0].nonce = "deadbeef";
    b.bids[0].commit = computeCommit("999999", "deadbeef", b.bids[0].bidderId);
    const commits = b.bids.map((x) => x.commit);
    b.witness.statement.merkleRoot = merkleRoot(commits);
    b.witness.statement.finalChainHead = finalChainHead(b.auctionId, commits);

    const r = verifyProofBundle(b);
    expect(r.rootMatches).toBe(true); // operator made their data consistent…
    expect(r.badReveals).toHaveLength(0);
    expect(r.tsaValid).toBe(false); // …but the witness signature exposes it
    expect(r.valid).toBe(false);
  });

  it("a corrupted timestamp signature fails verification", () => {
    const b = clone(valid);
    const sig = Buffer.from(b.witness.tsa.signature, "base64");
    sig[0] ^= 0xff;
    b.witness.tsa.signature = sig.toString("base64");
    const r = verifyProofBundle(b);
    expect(r.tsaValid).toBe(false);
    expect(r.valid).toBe(false);
  });

  it("count mismatch: dropping a sealed bid is caught", () => {
    const b = clone(valid);
    b.bids.pop();
    const r = verifyProofBundle(b);
    expect(r.valid).toBe(false);
    expect(r.countMatches).toBe(false);
  });

  it("temporal binding: a co-signature time far from the seal time fails even with a valid signature", async () => {
    const b = clone(valid);
    const statement = b.witness.statement;
    // A timestamp authority validly co-signs this exact statement, but stamps a
    // time an hour off from the asserted seal time.
    const offTsa = new Ed25519Tsa({
      clock: () => new Date(Date.parse(statement.sealedAt) + 3_600_000).toISOString(),
    });
    b.witness.tsa = await offTsa.sign(statement);
    const r = verifyProofBundle(b);
    expect(r.tsaValid).toBe(true); // the signature itself verifies…
    expect(r.tsaTimeConsistent).toBe(false); // …but the time doesn't track the seal
    expect(r.valid).toBe(false);
  });

  it("a failed witness yields no proof bundle — a partial seal can't read as valid", async () => {
    const failingWorm: WormWitness = {
      kind: "memory-worm",
      put: async () => {
        throw new Error("S3 PutObject failed");
      },
      get: async () => null,
      overwrite: async () => {
        throw new WitnessImmutableError("locked");
      },
      remove: async () => {
        throw new WitnessImmutableError("locked");
      },
    };
    const store = new MemoryStore({ worm: failingWorm });
    const meta = await store.createAuction({ title: "witness-fails" });
    const nonce = randomNonce();
    await store.appendCommit(meta.auctionId, {
      bidId: randomUUID(),
      bidderId: "acme",
      commit: computeCommit("100", nonce, "acme"),
    });
    await expect(store.seal(meta.auctionId, meta.sealToken)).rejects.toBeTruthy();
    // CLOSED but unwitnessed → the proof builder refuses to emit a bundle.
    await expect(buildProofBundle(store, meta.auctionId)).rejects.toBeTruthy();
  });
});
