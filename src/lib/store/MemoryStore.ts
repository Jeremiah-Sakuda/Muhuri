/**
 * In-memory LedgerStore.
 *
 * Runs the entire app and demo with zero cloud dependencies, and — critically —
 * upholds the same invariant as the real DynamoDB backend:
 *
 *  - The seal is an atomic compare-and-set on `status` plus the close-record
 *    write. JavaScript is single-threaded, so the seal's read-check-write runs
 *    as one synchronous critical section with no `await` inside it: nothing can
 *    interleave between flipping the status and freezing the root, exactly like
 *    a DynamoDB TransactWriteItems.
 *  - Post-close appends throw the SAME ConditionalCheckError class as Dynamo.
 *  - The external witness is a real WORM map that refuses every overwrite/delete
 *    plus an independent timestamp authority.
 *
 * The seal is also count-guarded: the Merkle root is computed over a consistent
 * snapshot, so a bid can never be both accepted-while-open and excluded from
 * the sealed root.
 */
import { randomUUID } from "node:crypto";
import {
  chainHeadZero,
  computeCommit,
  merkleRoot,
  nextChainHead,
} from "../crypto";
import { ConditionalCheckError, NotFoundError, ValidationError } from "../errors";
import type {
  AuctionMeta,
  AuditEvent,
  BidCommit,
  CloseRecord,
  SealStatement,
  WitnessBundle,
} from "../types";
import type {
  AppendCommitInput,
  AppendCommitResult,
  CreateAuctionInput,
  LedgerStore,
  RevealInput,
  TimestampAuthority,
  WormWitness,
} from "./LedgerStore";
import { MemoryWorm } from "./witness/MemoryWorm";
import { Ed25519Tsa } from "./witness/Ed25519Tsa";

/** Long-term retention for the witnessed proof (10 years). */
const DEFAULT_RETENTION_DAYS = 3650;

export interface MemoryStoreOptions {
  worm?: WormWitness;
  tsa?: TimestampAuthority;
  clock?: () => string;
  retentionDays?: number;
}

interface AuctionState {
  meta: AuctionMeta;
  bids: BidCommit[];
  close: CloseRecord | null;
  events: AuditEvent[];
  /** In-flight seal promise, for idempotent concurrent seals. */
  sealing: Promise<CloseRecord> | null;
}

export class MemoryStore implements LedgerStore {
  readonly backend = "memory" as const;
  readonly worm: WormWitness;
  readonly tsa: TimestampAuthority;
  private readonly clock: () => string;
  private readonly retentionDays: number;
  private readonly auctions = new Map<string, AuctionState>();

  constructor(opts: MemoryStoreOptions = {}) {
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.worm = opts.worm ?? new MemoryWorm(this.clock);
    this.tsa = opts.tsa ?? new Ed25519Tsa({ clock: this.clock });
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  private require(auctionId: string): AuctionState {
    const state = this.auctions.get(auctionId);
    if (!state) throw new NotFoundError(`auction ${auctionId} not found`);
    return state;
  }

  private emit(
    state: AuctionState,
    type: AuditEvent["type"],
    detail: AuditEvent["detail"],
  ): void {
    state.events.push({
      auctionId: state.meta.auctionId,
      seq: state.events.length,
      type,
      at: this.clock(),
      detail,
    });
  }

  async createAuction(input: CreateAuctionInput = {}): Promise<AuctionMeta> {
    const auctionId = input.auctionId ?? randomUUID();
    if (this.auctions.has(auctionId)) {
      throw new ValidationError(`auction ${auctionId} already exists`);
    }
    const meta: AuctionMeta = {
      auctionId,
      title: input.title ?? "Untitled auction",
      status: "OPEN",
      chainHead: chainHeadZero(auctionId),
      count: 0,
      sealToken: input.sealToken ?? randomUUID(),
      deadline: input.deadline,
      createdAt: this.clock(),
    };
    const state: AuctionState = { meta, bids: [], close: null, events: [], sealing: null };
    this.auctions.set(auctionId, state);
    this.emit(state, "AUCTION_CREATED", { title: meta.title });
    return { ...meta };
  }

  async appendCommit(
    auctionId: string,
    input: AppendCommitInput,
  ): Promise<AppendCommitResult> {
    // --- synchronous critical section: mirrors a conditional Put ---
    const state = this.require(auctionId);
    const { meta } = state;
    if (meta.status !== "OPEN") {
      // The database itself refuses a wrong-position-in-time write.
      throw new ConditionalCheckError(
        "AUCTION_CLOSED",
        `auction ${auctionId} is CLOSED; commit rejected`,
      );
    }
    if (state.bids.some((b) => b.bidId === input.bidId)) {
      throw new ValidationError(`bid ${input.bidId} already exists`);
    }
    const seq = meta.count;
    const chainHeadAfter = nextChainHead(meta.chainHead, input.commit, seq);
    const bid: BidCommit = {
      auctionId,
      bidId: input.bidId,
      seq,
      commit: input.commit,
      chainHeadAfter,
      bidderId: input.bidderId,
      createdAt: this.clock(),
      revealed: false,
    };
    state.bids.push(bid);
    meta.chainHead = chainHeadAfter;
    meta.count = seq + 1;
    // --- end critical section ---
    this.emit(state, "BID_COMMITTED", { seq, commit: input.commit, bidderId: input.bidderId });
    return { seq, chainHead: chainHeadAfter, chainHeadAfter };
  }

  async getChainHead(auctionId: string): Promise<string> {
    return this.require(auctionId).meta.chainHead;
  }

  seal(auctionId: string, sealToken: string): Promise<CloseRecord> {
    // The whole body up to the witnessing IIFE is synchronous, so two
    // concurrent seals cannot both flip OPEN→CLOSED.
    const state = this.require(auctionId);
    const { meta } = state;

    if (meta.status === "CLOSED") {
      // Already sealed. With the right token this is an idempotent no-op
      // (models ClientRequestToken); with the wrong token it is a conflict.
      if (meta.sealToken !== sealToken) {
        return Promise.reject(
          new ConditionalCheckError("ALREADY_SEALED", `auction ${auctionId} is already sealed`),
        );
      }
      return state.sealing ?? Promise.resolve({ ...state.close! });
    }
    if (meta.sealToken !== sealToken) {
      return Promise.reject(new ValidationError("invalid seal token"));
    }

    // Consistent snapshot → root covers exactly the bids present now.
    const commits = state.bids.map((b) => b.commit);
    const sealedAt = this.clock();
    const witnessKey = `auctions/${auctionId}/seal.json`;
    const statement: SealStatement = {
      auctionId,
      merkleRoot: merkleRoot(commits),
      finalChainHead: meta.chainHead,
      count: meta.count,
      sealedAt,
    };

    // Atomic flip + close-record write (all-or-nothing, exactly once).
    meta.status = "CLOSED";
    const close: CloseRecord = {
      auctionId,
      merkleRoot: statement.merkleRoot,
      finalChainHead: statement.finalChainHead,
      count: statement.count,
      sealedAt,
      deadline: meta.deadline,
      witnessKey,
    };
    state.close = close;
    this.emit(state, "SEALED", {
      merkleRoot: statement.merkleRoot,
      count: statement.count,
    });

    // The instant the seal commits, anchor it to the external witness quorum.
    const witnessing = (async (): Promise<CloseRecord> => {
      const tsa = await this.tsa.sign(statement);
      // The immutable object is self-contained: statement + independent token.
      const worm = await this.worm.put(witnessKey, { statement, tsa }, this.retentionDays);
      const witness: WitnessBundle = { statement, worm, tsa };
      close.witness = witness;
      close.witnessTimestamp = worm.storedAt;
      return { ...close };
    })();
    state.sealing = witnessing;
    return witnessing;
  }

  async getAuction(auctionId: string): Promise<AuctionMeta | null> {
    return this.auctions.has(auctionId) ? { ...this.require(auctionId).meta } : null;
  }

  async getCloseRecord(auctionId: string): Promise<CloseRecord | null> {
    const close = this.require(auctionId).close;
    return close ? { ...close } : null;
  }

  async getWitness(auctionId: string): Promise<WitnessBundle | null> {
    return this.require(auctionId).close?.witness ?? null;
  }

  async listBids(auctionId: string): Promise<BidCommit[]> {
    return this.require(auctionId).bids.map((b) => ({ ...b }));
  }

  async reveal(auctionId: string, input: RevealInput): Promise<{ ok: true }> {
    const state = this.require(auctionId);
    const bid = state.bids.find((b) => b.bidId === input.bidId);
    if (!bid) throw new NotFoundError(`bid ${input.bidId} not found`);
    // Defense in depth: the store rejects a reveal that doesn't open the
    // commit. (The verifier independently re-checks this without trusting us.)
    if (computeCommit(input.amount, input.nonce, bid.bidderId) !== bid.commit) {
      throw new ValidationError("reveal does not match the committed value");
    }
    bid.revealed = true;
    bid.amount = input.amount;
    bid.nonce = input.nonce;
    this.emit(state, "BID_REVEALED", { seq: bid.seq, amount: input.amount });
    return { ok: true };
  }

  async listEvents(auctionId: string): Promise<AuditEvent[]> {
    return this.require(auctionId).events.map((e) => ({ ...e }));
  }
}
