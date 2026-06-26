import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { computeCommit, finalChainHead, merkleRoot, randomNonce } from "@/lib/crypto";
import { MemoryStore } from "@/lib/store/MemoryStore";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import { buildProofBundle } from "@/lib/proof";
import { verifyProofBundle, type ProofBundle } from "@/lib/verifier";
import { verifyProofBundleBrowser } from "@/lib/verifier.browser";

async function honestBundle(): Promise<ProofBundle> {
  const store = new MemoryStore();
  const meta = await store.createAuction({ title: "Browser parity tender" });
  const id = meta.auctionId;
  const reveals: { bidId: string; amount: string; nonce: string }[] = [];
  for (const [bidderId, amount] of [
    ["acme", "1450000"],
    ["globex", "1399000"],
    ["initech", "1502500"],
  ] as const) {
    const nonce = randomNonce();
    const bidId = randomUUID();
    await store.appendCommit(id, { bidId, bidderId, commit: computeCommit(amount, nonce, bidderId) });
    reveals.push({ bidId, amount, nonce });
  }
  await store.seal(id, meta.sealToken);
  for (const r of reveals) await store.reveal(id, r);
  return buildProofBundle(store, id);
}

const clone = (b: ProofBundle): ProofBundle => structuredClone(b);

/** The two verifiers must agree on every field for the same bundle. */
async function expectParity(bundle: ProofBundle) {
  const node = verifyProofBundle(bundle);
  const browser = await verifyProofBundleBrowser(bundle);
  expect(browser.valid).toBe(node.valid);
  expect(browser.rootMatches).toBe(node.rootMatches);
  expect(browser.chainMatches).toBe(node.chainMatches);
  expect(browser.tsaValid).toBe(node.tsaValid);
  expect(browser.tsaTimeConsistent).toBe(node.tsaTimeConsistent);
  expect(browser.recomputedRoot).toBe(node.recomputedRoot);
  expect(browser.recomputedFinalChainHead).toBe(node.recomputedFinalChainHead);
  expect(browser.checks.map((c) => `${c.label}:${c.ok}`)).toEqual(
    node.checks.map((c) => `${c.label}:${c.ok}`),
  );
  return browser;
}

describe("browser verifier ≡ node verifier", () => {
  let valid: ProofBundle;
  beforeAll(async () => {
    valid = await honestBundle();
  });

  it("honest bundle: both verifiers say VALID", async () => {
    const r = await expectParity(valid);
    expect(r.valid).toBe(true);
  });

  it("tampered commit: both say INVALID (root mismatch)", async () => {
    const b = clone(valid);
    b.bids[1].commit = computeCommit("9", "x", b.bids[1].bidderId);
    const r = await expectParity(b);
    expect(r.valid).toBe(false);
    expect(r.rootMatches).toBe(false);
  });

  it("key-swap forgery: both say INVALID on the authority-signature check only", async () => {
    const b = clone(valid);
    const t = b.bids[0];
    t.amount = "1";
    t.commit = computeCommit("1", t.nonce ?? "0", t.bidderId);
    const commits = b.bids.map((x) => x.commit);
    b.witness.statement.merkleRoot = merkleRoot(commits);
    b.witness.statement.finalChainHead = finalChainHead(b.auctionId, commits);
    b.witness.tsa = await new Ed25519Tsa({}).sign(b.witness.statement); // operator's own key

    const r = await expectParity(b);
    expect(r.rootMatches).toBe(true);
    expect(r.tsaValid).toBe(false);
    expect(r.valid).toBe(false);
    // exactly one failing check, and it is the authority signature (the 7th)
    const failing = r.checks.filter((c) => !c.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0].label).toMatch(/Authority signature/);
  });
});
