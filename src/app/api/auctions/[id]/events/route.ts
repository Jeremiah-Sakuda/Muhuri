import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/** Append-only audit log projected from the change stream. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const events = await getStore().listEvents(id);
    return ok({ events });
  } catch (err) {
    return fail(err);
  }
}
