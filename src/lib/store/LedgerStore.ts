/**
 * The backend abstraction. One interface, two implementations:
 *   - MemoryStore: zero cloud deps, runs the full app + demo locally.
 *   - DynamoStore: real DynamoDB TransactWriteItems + S3 Object Lock.
 *
 * The same application code and the same invariant suite run against both. The
 * verifier never touches a store — it reads revealed bids + the witnessed root.
 */
import type {
  AuctionMeta,
  AuditEvent,
  BidCommit,
  CloseRecord,
  SealStatement,
  TsaAnchor,
  WitnessBundle,
  WormAnchor,
} from "../types";

export interface CreateAuctionInput {
  auctionId?: string;
  title?: string;
  deadline?: string;
  sealToken?: string;
}

export interface AppendCommitInput {
  bidId: string;
  commit: string;
  bidderId: string;
}

export interface AppendCommitResult {
  seq: number;
  /** Auction chain head after this append. */
  chainHead: string;
  chainHeadAfter: string;
}

export interface RevealInput {
  bidId: string;
  amount: string;
  nonce: string;
}

export interface LedgerStore {
  readonly backend: "memory" | "dynamo";

  /** Create an OPEN auction with a genesis chain head. */
  createAuction(input?: CreateAuctionInput): Promise<AuctionMeta>;

  /** Append a hash-committed bid; rejected with ConditionalCheckError if CLOSED. */
  appendCommit(
    auctionId: string,
    input: AppendCommitInput,
  ): Promise<AppendCommitResult>;

  /** Current public chain head. */
  getChainHead(auctionId: string): Promise<string>;

  /**
   * Atomically seal the auction: flip OPEN→CLOSED and freeze the Merkle root
   * in one all-or-nothing transaction, then anchor the proof to the external
   * witness quorum. Idempotent for a given sealToken.
   */
  seal(auctionId: string, sealToken: string): Promise<CloseRecord>;

  getAuction(auctionId: string): Promise<AuctionMeta | null>;
  getCloseRecord(auctionId: string): Promise<CloseRecord | null>;
  getWitness(auctionId: string): Promise<WitnessBundle | null>;
  listBids(auctionId: string): Promise<BidCommit[]>;

  /** Reveal {amount, nonce}; stored for the verifier (does not re-open). */
  reveal(auctionId: string, input: RevealInput): Promise<{ ok: true }>;

  /** Append-only audit log projected from the change stream. */
  listEvents(auctionId: string): Promise<AuditEvent[]>;

  /**
   * Demo/attack hook: attempt to overwrite the witnessed seal object. Always
   * rejects with WitnessImmutableError — memory hits the WORM map, Dynamo hits
   * S3 Object Lock. Lets the UI show the witness refusing tampering live.
   */
  attemptWitnessOverwrite(auctionId: string): Promise<never>;
}

/**
 * Write-once witness. `put` writes a new object and refuses to ever change it;
 * `overwrite` and `remove` exist only so attacks can prove they are refused
 * (they throw WitnessImmutableError). Models S3 Object Lock COMPLIANCE mode.
 */
export interface WormWitness {
  readonly kind: WormAnchor["kind"];
  put(
    key: string,
    body: unknown,
    retentionDays: number,
  ): Promise<WormAnchor>;
  get(key: string): Promise<{ anchor: WormAnchor; body: unknown } | null>;
  /** Attempt to overwrite — must throw WitnessImmutableError. */
  overwrite(key: string, body: unknown): Promise<never>;
  /** Attempt to delete — must throw WitnessImmutableError. */
  remove(key: string): Promise<never>;
}

/**
 * Independent timestamp authority. Holds a signing key the operator does not,
 * and co-signs the seal statement. Models RFC-3161 / OpenTimestamps.
 */
export interface TimestampAuthority {
  readonly kind: TsaAnchor["kind"];
  sign(statement: SealStatement): Promise<TsaAnchor>;
  /** Published public key, base64 SPKI. */
  publicKey(): string;
}
