/**
 * The invariant suite — the load-bearing spec of Muhuri.
 *
 * It is written once and run against EVERY backend (memory + dynamo). If a
 * store passes this suite, it upholds the marquee invariant: non-repudiable
 * ordering and tamper-evidence in time. Four properties:
 *
 *   1. append → chainHead   ordering is fixed and recomputable
 *   2. seal atomicity       OPEN→CLOSED + frozen Merkle root, exactly once
 *   3. post-close rejection  the DB itself refuses a wrong-position-in-time write
 *   4. witness immutability  the external anchor cannot be altered or deleted
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  computeCommit,
  randomNonce,
  chainHeadZero,
  nextChainHead,
  merkleRoot,
  finalChainHead,
} from "../../src/lib/crypto";
import { ConditionalCheckError, WitnessImmutableError } from "../../src/lib/errors";
import type { LedgerStore, WormWitness } from "../../src/lib/store/LedgerStore";

export interface Harness {
  store: LedgerStore;
  /** The very WORM witness backing this store, so attacks hit the real thing. */
  worm: WormWitness;
}

export type MakeHarness = () => Promise<Harness> | Harness;

interface TestBid {
  bidId: string;
  bidderId: string;
  amount: string;
  nonce: string;
  commit: string;
}

function makeBid(bidderId: string, amount: string): TestBid {
  const nonce = randomNonce();
  const bidId = randomUUID();
  return { bidId, bidderId, amount, nonce, commit: computeCommit(amount, nonce, bidderId) };
}

/** Run the full invariant suite against one backend. */
export function invariantSuite(label: string, makeHarness: MakeHarness): void {
  describe(`invariants [${label}]`, () => {
    it("append → chainHead: ordering is fixed and independently recomputable", async () => {
      const { store } = await makeHarness();
      const meta = await store.createAuction({ title: "Bridge tender" });
      const id = meta.auctionId;

      // Genesis head is H(auctionId).
      expect(await store.getChainHead(id)).toBe(chainHeadZero(id));

      const bids = [makeBid("acme", "1000"), makeBid("globex", "1200"), makeBid("initech", "950")];
      let expectedHead = chainHeadZero(id);
      for (let i = 0; i < bids.length; i++) {
        const res = await store.appendCommit(id, bids[i]);
        expectedHead = nextChainHead(expectedHead, bids[i].commit, i);
        expect(res.seq).toBe(i);
        expect(res.chainHeadAfter).toBe(expectedHead);
        expect(res.chainHead).toBe(expectedHead);
      }

      // Stored bids are returned in arrival order with correct seq + heads.
      const stored = await store.listBids(id);
      expect(stored.map((b) => b.seq)).toEqual([0, 1, 2]);
      expect(stored.map((b) => b.bidId)).toEqual(bids.map((b) => b.bidId));

      // The public head equals an independent recomputation of the whole chain.
      expect(await store.getChainHead(id)).toBe(
        finalChainHead(id, bids.map((b) => b.commit)),
      );
    });

    it("seal atomicity: OPEN→CLOSED + frozen root, witnessed, exactly once", async () => {
      const { store } = await makeHarness();
      const meta = await store.createAuction({ title: "Spectrum auction" });
      const id = meta.auctionId;

      const bids = [makeBid("a", "5"), makeBid("b", "7"), makeBid("c", "6"), makeBid("d", "9")];
      for (const b of bids) await store.appendCommit(id, b);

      const close = await store.seal(id, meta.sealToken);

      // Status flipped.
      expect((await store.getAuction(id))?.status).toBe("CLOSED");

      // Close record froze the exact ordered set + chain head + count.
      const commits = bids.map((b) => b.commit);
      expect(close.merkleRoot).toBe(merkleRoot(commits));
      expect(close.finalChainHead).toBe(finalChainHead(id, commits));
      expect(close.count).toBe(bids.length);
      expect(close.sealedAt).toBeTruthy();

      // The seal was anchored to the external witness quorum (WORM + TSA),
      // and both attest to the same root.
      expect(close.witness).toBeTruthy();
      expect(close.witness!.worm.mode).toBe("COMPLIANCE");
      expect(close.witness!.statement.merkleRoot).toBe(close.merkleRoot);
      expect(close.witness!.tsa.signature).toBeTruthy();

      // Idempotent: sealing again with the same token is a no-op, not a re-seal.
      const close2 = await store.seal(id, meta.sealToken);
      expect(close2.sealedAt).toBe(close.sealedAt);
      expect(close2.merkleRoot).toBe(close.merkleRoot);
      expect(close2.witnessTimestamp).toBe(close.witnessTimestamp);
    });

    it("post-close rejection: the database refuses a late bid", async () => {
      const { store } = await makeHarness();
      const meta = await store.createAuction({ title: "Grant round" });
      const id = meta.auctionId;
      await store.appendCommit(id, makeBid("a", "1"));
      const close = await store.seal(id, meta.sealToken);

      // A fully valid, chain-consistent late bid is still rejected — wrong
      // position in time, enforced by the conditional write itself.
      const late = makeBid("latecomer", "999999");
      await expect(store.appendCommit(id, late)).rejects.toBeInstanceOf(
        ConditionalCheckError,
      );
      await expect(store.appendCommit(id, late)).rejects.toMatchObject({
        reason: "AUCTION_CLOSED",
      });

      // The seal and the witnessed root are unchanged by the attempt.
      const after = await store.getCloseRecord(id);
      expect(after?.merkleRoot).toBe(close.merkleRoot);
      expect(after?.count).toBe(1);
    });

    it("witness immutability: the external anchor cannot be altered or deleted", async () => {
      const { store, worm } = await makeHarness();
      const meta = await store.createAuction({ title: "M&A sale process" });
      const id = meta.auctionId;
      await store.appendCommit(id, makeBid("a", "100"));
      const close = await store.seal(id, meta.sealToken);
      const key = close.witnessKey;

      // The operator (who controls the DB) cannot overwrite or delete the
      // externally-witnessed copy — COMPLIANCE-mode WORM refuses both.
      await expect(worm.overwrite(key, { merkleRoot: "forged" })).rejects.toBeInstanceOf(
        WitnessImmutableError,
      );
      await expect(worm.remove(key)).rejects.toBeInstanceOf(WitnessImmutableError);

      // The witnessed body still holds the real root.
      const fetched = await worm.get(key);
      expect(
        (fetched?.body as { statement: { merkleRoot: string } }).statement.merkleRoot,
      ).toBe(close.merkleRoot);
    });
  });
}
