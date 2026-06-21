/** Typed browser client for the Muhuri API. Throws ApiError on non-2xx so the
 *  UI can show the database's actual rejection (e.g. 409 ConditionalCheckFailed). */
import type {
  AuctionMeta,
  AuditEvent,
  BidCommit,
  CloseRecord,
  WitnessBundle,
} from "@/lib/types";
import type { ProofBundle, VerificationResult } from "@/lib/verifier";

export interface AuctionView {
  meta: AuctionMeta;
  bids: BidCommit[];
  close: CloseRecord | null;
  chainHead: string;
}

export interface DemoSeed {
  auctionId: string;
  sealToken: string;
  reveals: { bidId: string; bidderId: string; amount: string; nonce: string }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public reason?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data && data.error) || res.statusText,
      data?.code,
      data?.reason,
    );
  }
  return data as T;
}

export const api = {
  createAuction: (b?: { title?: string; deadline?: string }) =>
    req<AuctionMeta>("POST", "/api/auctions", b ?? {}),
  seedDemo: (b?: { title?: string; deadline?: string }) =>
    req<DemoSeed>("POST", "/api/demo", b ?? {}),
  getAuction: (id: string) => req<AuctionView>("GET", `/api/auctions/${id}`),
  getEvents: (id: string) => req<{ events: AuditEvent[] }>("GET", `/api/auctions/${id}/events`),
  appendBid: (id: string, b: { bidId: string; commit: string; bidderId: string }) =>
    req<{ seq: number; chainHead: string }>("POST", `/api/auctions/${id}/bids`, b),
  seal: (id: string, sealToken: string) =>
    req<CloseRecord>("POST", `/api/auctions/${id}/seal`, { sealToken }),
  reveal: (id: string, b: { bidId: string; amount: string; nonce: string }) =>
    req<{ ok: true }>("POST", `/api/auctions/${id}/reveal`, b),
  getWitness: (id: string) => req<WitnessBundle>("GET", `/api/auctions/${id}/witness`),
  getProof: (id: string) => req<ProofBundle>("GET", `/api/auctions/${id}/proof`),
  verify: (bundle: ProofBundle) => req<VerificationResult>("POST", "/api/verify", bundle),
  attackOverwrite: (id: string) =>
    req<unknown>("POST", `/api/auctions/${id}/witness-overwrite`),
  health: () => req<{ backend: string; region: string; witness: string }>("GET", "/api/health"),
};
