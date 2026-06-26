import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Full auction view: meta + ordered bids + chain head + close record. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const store = getStore();
    const meta = await store.getAuction(id);
    if (!meta) throw new NotFoundError(`session ${id} not found`);
    const [bids, close] = await Promise.all([
      store.listBids(id),
      store.getCloseRecord(id),
    ]);
    return ok({ meta, bids, close, chainHead: meta.chainHead });
  } catch (err) {
    return fail(err);
  }
}
