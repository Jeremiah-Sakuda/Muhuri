import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";
import { computeCommit, randomNonce } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/** A seeded autonomous-agent action trace: what the agent did, in order. */
const DEFAULT_TRACE: { actionType: string; detail: string }[] = [
  { actionType: "read_file", detail: "/data/customer_records.csv" },
  { actionType: "web_search", detail: "vendor invoice dispute resolution" },
  { actionType: "db_query", detail: "SELECT * FROM payouts WHERE status='pending'" },
  { actionType: "send_email", detail: "to: finance@acme.com — approve Vendor-7741" },
  { actionType: "execute_payment", detail: "$48,500 → Vendor-7741" },
];

/**
 * Seed a demo agent session with a handful of committed actions. Returns the
 * reveals so the UI can open them after sealing. (Convenience only — the manual
 * "log action" flow commits client-side so the detail never reaches the server
 * until reveal.)
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      deadline?: string;
      actions?: { actionType: string; detail: string }[];
    };
    const store = getStore();
    const meta = await store.createAuction({
      title: body.title ?? "Agent session — payments-ops-bot · run 4f2a91",
      deadline: body.deadline,
    });
    const actions = body.actions ?? DEFAULT_TRACE;
    // `bidderId` carries the action type; the committed secret (`amount`) carries
    // the action detail. The cryptographic core is unchanged.
    const reveals: { bidId: string; bidderId: string; amount: string; nonce: string }[] = [];
    for (const action of actions) {
      const nonce = randomNonce();
      const bidId = randomUUID();
      await store.appendCommit(meta.auctionId, {
        bidId,
        bidderId: action.actionType,
        commit: computeCommit(action.detail, nonce, action.actionType),
      });
      reveals.push({ bidId, bidderId: action.actionType, amount: action.detail, nonce });
    }
    return ok({ auctionId: meta.auctionId, sealToken: meta.sealToken, reveals }, 201);
  } catch (err) {
    return fail(err);
  }
}
