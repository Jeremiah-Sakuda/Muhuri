import { ok, fail, readJson } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { verifyProofBundle, type ProofBundle } from "@/lib/verifier";
import type { WitnessBundle } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Verify a proof bundle server-side (the same code the standalone CLI runs).
 * Accepts the downloaded bundle shape `{ auctionId, witness, bids }` or the
 * PRD shape `{ seal, bids }`.
 */
export async function POST(req: Request) {
  try {
    const body = await readJson<Record<string, unknown>>(req);
    return ok(verifyProofBundle(normalize(body)));
  } catch (err) {
    return fail(err);
  }
}

function normalize(body: Record<string, unknown>): ProofBundle {
  if (body.witness && Array.isArray(body.bids) && typeof body.auctionId === "string") {
    return body as unknown as ProofBundle;
  }
  if (body.seal && Array.isArray(body.bids)) {
    const seal = body.seal as WitnessBundle;
    const auctionId = (body.auctionId as string) ?? seal.statement?.auctionId;
    if (!auctionId) throw new ValidationError("missing auctionId");
    return { auctionId, witness: seal, bids: body.bids as ProofBundle["bids"] };
  }
  throw new ValidationError(
    "expected { auctionId, witness, bids } or { seal, bids }",
  );
}
