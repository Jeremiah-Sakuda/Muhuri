import { getStore } from "@/lib/store";
import { ok, fail, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** Append a hash-committed bid. Rejected with 409 if the auction is CLOSED. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ bidId: string; commit: string; bidderId: string }>(req);
    const result = await getStore().appendCommit(id, {
      bidId: body.bidId,
      commit: body.commit,
      bidderId: body.bidderId,
    });
    return ok(result, 201);
  } catch (err) {
    return fail(err);
  }
}
