import { getStore } from "@/lib/store";
import { fail } from "@/lib/api/http";
import { buildProofBundle } from "@/lib/proof";

export const dynamic = "force-dynamic";

/** Download the self-contained proof bundle the standalone verifier consumes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const bundle = await buildProofBundle(getStore(), id);
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="muhuri-proof-${id}.json"`,
      },
    });
  } catch (err) {
    return fail(err);
  }
}
