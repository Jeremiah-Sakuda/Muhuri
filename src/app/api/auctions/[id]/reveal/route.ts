import { getStore } from "@/lib/store";
import { ok, fail, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** Reveal {amount, nonce} for a bid. The store rejects a reveal that doesn't
 *  open the commitment; the verifier independently re-checks it. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ bidId: string; amount: string; nonce: string }>(req);
    const result = await getStore().reveal(id, {
      bidId: body.bidId,
      amount: body.amount,
      nonce: body.nonce,
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
