import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";
import { computeCommit, randomNonce } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const DEFAULT_BIDDERS = [
  "Acme Infrastructure",
  "Globex Networks",
  "Initech Civil",
  "Umbrella Telecom",
];

/**
 * Seed a demo auction with a handful of committed bids. Returns the reveals so
 * the UI can open them after sealing. (Convenience only — the manual bid flow
 * commits client-side so the amount never reaches the server until reveal.)
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      deadline?: string;
      bidders?: string[];
    };
    const store = getStore();
    const meta = await store.createAuction({
      title: body.title ?? "Municipal fiber-optic build-out — RFP-2026-114",
      deadline: body.deadline,
    });
    const bidders = body.bidders ?? DEFAULT_BIDDERS;
    const reveals: { bidId: string; bidderId: string; amount: string; nonce: string }[] = [];
    for (const bidderId of bidders) {
      const amount = String(900_000 + Math.floor(Math.random() * 300_000));
      const nonce = randomNonce();
      const bidId = randomUUID();
      await store.appendCommit(meta.auctionId, {
        bidId,
        bidderId,
        commit: computeCommit(amount, nonce, bidderId),
      });
      reveals.push({ bidId, bidderId, amount, nonce });
    }
    return ok({ auctionId: meta.auctionId, sealToken: meta.sealToken, reveals }, 201);
  } catch (err) {
    return fail(err);
  }
}
