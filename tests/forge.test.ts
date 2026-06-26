import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { computeCommit, randomNonce } from "@/lib/crypto";
import { MemoryStore } from "@/lib/store/MemoryStore";
import { buildProofBundle } from "@/lib/proof";
import { forgeWinningBid, operatorConsistencyCheck } from "@/lib/forge-browser";
import { verifyProofBundleBrowser } from "@/lib/verifier.browser";
import type { ProofBundle } from "@/lib/verifier";

async function sealedBundle(): Promise<ProofBundle> {
  const store = new MemoryStore();
  const meta = await store.createAuction({ title: "Forge tender" });
  const reveals: { bidId: string; amount: string; nonce: string }[] = [];
  for (const [bidderId, amount] of [
    ["acme", "1450000"],
    ["globex", "1399000"],
    ["initech", "1502500"],
  ] as const) {
    const nonce = randomNonce();
    const bidId = randomUUID();
    await store.appendCommit(meta.auctionId, { bidId, bidderId, commit: computeCommit(amount, nonce, bidderId) });
    reveals.push({ bidId, amount, nonce });
  }
  await store.seal(meta.auctionId, meta.sealToken);
  for (const r of reveals) await store.reveal(meta.auctionId, r);
  return buildProofBundle(store, meta.auctionId);
}

describe("forge-and-rebuild (the perfect crime)", () => {
  it("operator console passes, but the offline verifier rejects on the authority signature alone", async () => {
    const honest = await sealedBundle();
    const { forged, originalDetail, newDetail } = await forgeWinningBid(honest);
    expect(newDetail).not.toBe(originalDetail);
    expect(Number(newDetail)).toBeLessThan(Number(originalDetail));

    // The operator's own console: everything is internally consistent.
    const op = await operatorConsistencyCheck(forged);
    expect(op.allOk).toBe(true);
    expect(op.checks.every((c) => c.ok)).toBe(true);

    // The independent verifier: INVALID, and exactly one check fails — the 7th.
    const v = await verifyProofBundleBrowser(forged);
    expect(v.rootMatches).toBe(true);
    expect(v.chainMatches).toBe(true);
    expect(v.badReveals).toHaveLength(0);
    expect(v.tsaTimeConsistent).toBe(true);
    expect(v.tsaValid).toBe(false);
    expect(v.valid).toBe(false);
    const failing = v.checks.filter((c) => !c.ok);
    expect(failing).toHaveLength(1);
    expect(failing[0].label).toMatch(/Authority signature/);

    // The honest bundle still verifies, so the contrast is real.
    expect((await verifyProofBundleBrowser(honest)).valid).toBe(true);
  });
});
