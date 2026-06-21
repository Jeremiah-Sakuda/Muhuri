import { ok } from "@/lib/api/http";
import { backendName } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Backend + region badge for the UI. */
export async function GET() {
  const backend = backendName();
  return ok({
    backend,
    region: process.env.AWS_REGION ?? "local",
    witness: backend === "dynamo" ? "s3-object-lock" : "memory-worm",
  });
}
