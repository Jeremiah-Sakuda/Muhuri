import { getStore } from "@/lib/store";
import { ok, fail, readJson } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * Atomically seal the auction and anchor it to the external witness quorum.
 * Idempotent for a given sealToken (a retry returns the same close record).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{ sealToken: string }>(req);
    const close = await getStore().seal(id, body.sealToken);
    return ok(close);
  } catch (err) {
    return fail(err);
  }
}
