import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** The externally-witnessed seal (read-through from S3 Object Lock / WORM map). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const witness = await getStore().getWitness(id);
    if (!witness) throw new NotFoundError(`session ${id} has not been sealed`);
    return ok(witness);
  } catch (err) {
    return fail(err);
  }
}
