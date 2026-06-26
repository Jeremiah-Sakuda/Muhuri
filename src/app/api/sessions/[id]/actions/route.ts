import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import { ok, fail, readJson } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { computeCommit, randomNonce } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/**
 * Agent ingestion shim — a drop-in adapter for any agent runtime.
 *
 * An agent (or an MCP tool-call wrapper) logs a single action by its hash:
 *   POST /api/sessions/:id/actions
 *   { actionType: "execute_payment", payloadHash: "<sha256 of the payload>",
 *     agentId?: "payments-ops-bot", nonce?: "<hex>" }
 *
 * The raw payload never reaches the server — only its hash is committed — so
 * this works for sensitive tool calls. The agent keeps {payloadHash, nonce} to
 * reveal to an auditor later. It wraps the exact same `appendCommit` the rest of
 * the app uses, so the action joins the same order-fixing chain and seal.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJson<{
      actionType: string;
      payloadHash: string;
      agentId?: string;
      nonce?: string;
      actionId?: string;
    }>(req);
    if (!body.actionType || !body.payloadHash) {
      throw new ValidationError("actionType and payloadHash are required");
    }
    const nonce = body.nonce ?? randomNonce();
    const actionId = body.actionId ?? randomUUID();
    const bidderId = body.agentId ? `${body.agentId}:${body.actionType}` : body.actionType;
    const commit = computeCommit(body.payloadHash, nonce, bidderId);
    const result = await getStore().appendCommit(id, { bidId: actionId, commit, bidderId });
    return ok({ actionId, seq: result.seq, chainHead: result.chainHead, nonce }, 201);
  } catch (err) {
    return fail(err);
  }
}
