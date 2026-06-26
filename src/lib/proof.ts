/**
 * Assembles the self-contained proof bundle an outsider verifies: the
 * externally-witnessed seal plus every revealed bid. This is what the
 * `GET /api/auctions/:id` "download proof bundle" action and the CLI consume.
 */
import { NotFoundError } from "./errors";
import type { LedgerStore } from "./store/LedgerStore";
import type { ProofBundle } from "./verifier";

export async function buildProofBundle(
  store: LedgerStore,
  auctionId: string,
): Promise<ProofBundle> {
  const witness = await store.getWitness(auctionId);
  if (!witness) throw new NotFoundError(`session ${auctionId} is not sealed yet`);
  const bids = await store.listBids(auctionId);
  return {
    auctionId,
    witness,
    bids: bids.map((b) => ({
      seq: b.seq,
      bidId: b.bidId,
      bidderId: b.bidderId,
      commit: b.commit,
      amount: b.amount,
      nonce: b.nonce,
    })),
  };
}
