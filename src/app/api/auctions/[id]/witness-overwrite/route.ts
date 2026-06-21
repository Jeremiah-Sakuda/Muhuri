import { getStore } from "@/lib/store";
import { fail } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * Demo attack: the operator tries to overwrite the witnessed seal. The WORM
 * witness (S3 Object Lock COMPLIANCE / in-memory equivalent) refuses, so this
 * always returns 403 — proving the external anchor cannot be rewritten.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await getStore().attemptWitnessOverwrite(id);
    // Unreachable: the call above always throws.
    return fail(new Error("witness overwrite unexpectedly succeeded"));
  } catch (err) {
    return fail(err);
  }
}
