/**
 * Domain types shared across stores, API, verifier, and UI.
 *
 * These mirror the single-table layout (see DynamoStore): an auction META item,
 * BID commit items, and one CLOSE record written only inside the seal
 * transaction. The witness types model the external anchors that make the seal
 * non-repudiable.
 */

export type AuctionStatus = "OPEN" | "CLOSED";

/** Session meta item — PK=SESSION#<id>, SK=META. */
export interface AuctionMeta {
  auctionId: string;
  title: string;
  status: AuctionStatus;
  /** Public head of the append-only commit chain; ticks as bids arrive. */
  chainHead: string;
  /** Number of committed bids. */
  count: number;
  /** Idempotency token for the seal (ClientRequestToken on Dynamo). */
  sealToken: string;
  /** Optional deadline claim; "before the deadline" is judged vs the witness. */
  deadline?: string;
  createdAt: string;
}

/** An action commit item — PK=SESSION#<id>, SK=ACTION#<seq:012d>#<id>. */
export interface BidCommit {
  auctionId: string;
  bidId: string;
  seq: number;
  commit: string;
  /** Chain head immediately after folding this commit in. */
  chainHeadAfter: string;
  bidderId: string;
  createdAt: string;
  revealed: boolean;
  amount?: string;
  nonce?: string;
}

/**
 * The exact statement that gets witnessed at seal time. Both external anchors
 * (WORM + TSA) attest to *this* — it is what the offline verifier recomputes.
 */
export interface SealStatement {
  auctionId: string;
  merkleRoot: string;
  finalChainHead: string;
  count: number;
  sealedAt: string;
}

/** Witness backed by write-once storage (S3 Object Lock, or the memory WORM). */
export interface WormAnchor {
  kind: "memory-worm" | "s3-object-lock";
  /** Deterministic key, e.g. sessions/<id>/seal.json. */
  key: string;
  mode: "COMPLIANCE";
  /** ISO time the object was written. */
  storedAt: string;
  /** ISO time until which the object cannot be altered or deleted. */
  retainUntil: string;
  /** Where it lives, e.g. s3://bucket/key or worm://memory/key. */
  uri: string;
  /** S3 version id when available. */
  versionId?: string;
}

/**
 * Witness backed by a timestamp authority that *signs* the statement. Models
 * RFC-3161 / OpenTimestamps: the authority co-signs the root + time, and the
 * verifier checks the signature against an independently-pinned public key — so
 * once the key lives outside the operator, a forged root cannot carry a valid
 * signature. (In this build the key is operator-held; see Ed25519Tsa.)
 */
export interface TsaAnchor {
  kind: "memory-tsa" | "ed25519-tsa";
  authority: string;
  algorithm: "ed25519";
  /** Base64 SPKI public key — published; used for offline verification. */
  publicKey: string;
  /** Base64 signature over the canonical statement. */
  signature: string;
  /** ISO time asserted by the authority. */
  signedAt: string;
}

/**
 * The full witness bundle written at the instant of seal. This is the
 * `seal.json` an outsider holds; the verifier trusts this copy, not the DB.
 */
export interface WitnessBundle {
  statement: SealStatement;
  worm: WormAnchor;
  tsa: TsaAnchor;
}

/** Close record item — PK=SESSION#<id>, SK=CLOSE. Written only in the seal txn. */
export interface CloseRecord {
  auctionId: string;
  merkleRoot: string;
  finalChainHead: string;
  count: number;
  sealedAt: string;
  deadline?: string;
  /** Deterministic witness key, known before the transaction. */
  witnessKey: string;
  /** Set after the external witness is anchored. */
  witnessTimestamp?: string;
  /** The external anchors (present once witnessing completes). */
  witness?: WitnessBundle;
}

/** Append-only audit event projected from the change stream. */
export interface AuditEvent {
  auctionId: string;
  seq: number;
  type: "AUCTION_CREATED" | "BID_COMMITTED" | "BID_REVEALED" | "SEALED";
  at: string;
  detail: Record<string, string | number | boolean>;
}

/** Public-facing snapshot used by the UI and the verifier. */
export interface AuctionView {
  meta: AuctionMeta;
  bids: BidCommit[];
  close: CloseRecord | null;
}
