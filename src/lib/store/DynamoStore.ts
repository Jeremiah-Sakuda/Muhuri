/**
 * Real DynamoDB-backed LedgerStore — the protagonist of the system.
 *
 * Single-table design (one table, three item types under one partition key):
 *   META   AUCTION#<id> / META                  status, chainHead, count, sealToken
 *   BID    AUCTION#<id> / BID#<seq:012d>#<bidId> commit, chainHeadAfter, …
 *   CLOSE  AUCTION#<id> / CLOSE                  merkleRoot, witness — sealed only
 *
 * The seal is a genuine atomic two-item TransactWriteItems:
 *   1. Update META: SET status = CLOSED   IF status = OPEN AND count = :n
 *   2. Put CLOSE   (Merkle root)          IF attribute_not_exists(SK)
 * all-or-nothing, with ClientRequestToken = sealToken for idempotency. A late
 * bid cannot wedge between the two writes, and the count guard guarantees the
 * root covers exactly the bids that were accepted while OPEN. The same
 * conditional primitive rejects post-close appends.
 *
 * Zero-padded seq means the sort key's lexical order equals arrival order, so a
 * single Query returns bids chronologically with no client-side sort. The seal
 * touches exactly two items (root pre-computed from that Query) regardless of
 * bid count.
 */
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { chainHeadZero, merkleRoot, nextChainHead, computeCommit } from "../crypto";
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
import { Ed25519Tsa } from "./witness/Ed25519Tsa";
import { S3ObjectLockWorm } from "./witness/S3ObjectLockWorm";

const DEFAULT_RETENTION_DAYS = 3650;
const MAX_ATTEMPTS = 8;

const pk = (auctionId: string) => `AUCTION#${auctionId}`;
const SK_META = "META";
const SK_CLOSE = "CLOSE";
const skBid = (seq: number, bidId: string) =>
  `BID#${String(seq).padStart(12, "0")}#${bidId}`;

function isTransactionCanceled(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionCanceledException";
}
function isConditionalFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

export interface DynamoStoreOptions {
  table: string;
  region?: string;
  doc?: DynamoDBDocumentClient;
  worm?: WormWitness;
  tsa?: TimestampAuthority;
  retentionDays?: number;
  clock?: () => string;
}

export class DynamoStore implements LedgerStore {
  readonly backend = "dynamo" as const;
  readonly worm: WormWitness;
  readonly tsa: TimestampAuthority;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly retentionDays: number;
  private readonly clock: () => string;

  constructor(opts: DynamoStoreOptions) {
    this.table = opts.table;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.doc =
      opts.doc ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
    this.worm = opts.worm ?? new S3ObjectLockWorm({ bucket: requireEnv("MUHURI_WITNESS_BUCKET"), region: opts.region });
    this.tsa = opts.tsa ?? new Ed25519Tsa({ kind: "ed25519-tsa", clock: this.clock, privateKeyPem: process.env.MUHURI_TSA_PRIVATE_KEY });
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  // --- reads ---------------------------------------------------------------
  private async getMeta(auctionId: string): Promise<AuctionMeta | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk(auctionId), SK: SK_META } }),
    );
    return (res.Item as AuctionMeta | undefined) ?? null;
  }

  private async getClose(auctionId: string): Promise<CloseRecord | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk(auctionId), SK: SK_CLOSE } }),
    );
    return (res.Item as CloseRecord | undefined) ?? null;
  }

  async getAuction(auctionId: string): Promise<AuctionMeta | null> {
    return this.getMeta(auctionId);
  }

  async getChainHead(auctionId: string): Promise<string> {
    const meta = await this.getMeta(auctionId);
    if (!meta) throw new NotFoundError(`auction ${auctionId} not found`);
    return meta.chainHead;
  }

  async listBids(auctionId: string): Promise<BidCommit[]> {
    const bids: BidCommit[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :bid)",
          ExpressionAttributeValues: { ":pk": pk(auctionId), ":bid": "BID#" },
          ExclusiveStartKey,
        }),
      );
      for (const item of res.Items ?? []) bids.push(item as BidCommit);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return bids;
  }

  async getCloseRecord(auctionId: string): Promise<CloseRecord | null> {
    return this.getClose(auctionId);
  }

  async getWitness(auctionId: string): Promise<WitnessBundle | null> {
    const close = await this.getClose(auctionId);
    if (close?.witness) return close.witness;
    if (close?.witnessKey) {
      const fetched = await this.worm.get(close.witnessKey);
      if (fetched) {
        const body = fetched.body as { statement: SealStatement; tsa: WitnessBundle["tsa"] };
        return { statement: body.statement, worm: fetched.anchor, tsa: body.tsa };
      }
    }
    return null;
  }

  // --- writes --------------------------------------------------------------
  async createAuction(input: CreateAuctionInput = {}): Promise<AuctionMeta> {
    const auctionId = input.auctionId ?? randomUUID();
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
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { PK: pk(auctionId), SK: SK_META, type: "auction", ...meta },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (err) {
      if (isConditionalFailed(err)) throw new ValidationError(`auction ${auctionId} already exists`);
      throw err;
    }
    return meta;
  }

  async appendCommit(auctionId: string, input: AppendCommitInput): Promise<AppendCommitResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const meta = await this.getMeta(auctionId);
      if (!meta) throw new NotFoundError(`auction ${auctionId} not found`);
      if (meta.status !== "OPEN") {
        throw new ConditionalCheckError("AUCTION_CLOSED", `auction ${auctionId} is CLOSED; commit rejected`);
      }
      const seq = meta.count;
      const after = nextChainHead(meta.chainHead, input.commit, seq);
      const bid: BidCommit = {
        auctionId,
        bidId: input.bidId,
        seq,
        commit: input.commit,
        chainHeadAfter: after,
        bidderId: input.bidderId,
        createdAt: this.clock(),
        revealed: false,
      };
      try {
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.table,
                  Key: { PK: pk(auctionId), SK: SK_META },
                  ConditionExpression: "#s = :open AND #c = :seq",
                  UpdateExpression: "SET #c = :next, chainHead = :after",
                  ExpressionAttributeNames: { "#s": "status", "#c": "count" },
                  ExpressionAttributeValues: { ":open": "OPEN", ":seq": seq, ":next": seq + 1, ":after": after },
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { PK: pk(auctionId), SK: skBid(seq, input.bidId), type: "bid", ...bid },
                  ConditionExpression: "attribute_not_exists(SK)",
                },
              },
            ],
          }),
        );
        return { seq, chainHead: after, chainHeadAfter: after };
      } catch (err) {
        // A racing append moved the count, or a seal flipped the status.
        // Re-read at the top of the loop decides which: CLOSED → reject.
        if (isTransactionCanceled(err)) continue;
        throw err;
      }
    }
    throw new ConditionalCheckError("COUNT_CONFLICT", "too much contention appending the bid");
  }

  async seal(auctionId: string, sealToken: string): Promise<CloseRecord> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const meta = await this.getMeta(auctionId);
      if (!meta) throw new NotFoundError(`auction ${auctionId} not found`);

      if (meta.status === "CLOSED") {
        if (meta.sealToken !== sealToken) {
          throw new ConditionalCheckError("ALREADY_SEALED", `auction ${auctionId} is already sealed`);
        }
        const existing = await this.ensureWitnessed(auctionId);
        if (existing) return existing;
      }
      if (meta.sealToken !== sealToken) throw new ValidationError("invalid seal token");

      const bids = await this.listBids(auctionId);
      const commits = bids.map((b) => b.commit);
      const sealedAt = this.clock();
      const witnessKey = `auctions/${auctionId}/seal.json`;
      const statement: SealStatement = {
        auctionId,
        merkleRoot: merkleRoot(commits),
        finalChainHead: meta.chainHead,
        count: meta.count,
        sealedAt,
      };
      const closeBase: CloseRecord = {
        auctionId,
        merkleRoot: statement.merkleRoot,
        finalChainHead: statement.finalChainHead,
        count: statement.count,
        sealedAt,
        deadline: meta.deadline,
        witnessKey,
      };

      try {
        await this.doc.send(
          new TransactWriteCommand({
            ClientRequestToken: sealToken, // idempotent seal
            TransactItems: [
              {
                Update: {
                  TableName: this.table,
                  Key: { PK: pk(auctionId), SK: SK_META },
                  ConditionExpression: "#s = :open AND #c = :count",
                  UpdateExpression: "SET #s = :closed",
                  ExpressionAttributeNames: { "#s": "status", "#c": "count" },
                  ExpressionAttributeValues: { ":open": "OPEN", ":closed": "CLOSED", ":count": meta.count },
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { PK: pk(auctionId), SK: SK_CLOSE, type: "close", ...closeBase },
                  ConditionExpression: "attribute_not_exists(SK)",
                },
              },
            ],
          }),
        );
      } catch (err) {
        if (isTransactionCanceled(err)) continue; // status flipped or count moved; re-read
        throw err;
      }

      // Seal committed atomically. Anchor the witness quorum, tolerating a
      // concurrent sealer that already wrote the witness.
      return this.witnessSeal(auctionId, statement, witnessKey, closeBase);
    }
    throw new ConditionalCheckError("COUNT_CONFLICT", "too much contention sealing the auction");
  }

  /** If already witnessed, return the close record; else null (still needs sealing). */
  private async ensureWitnessed(auctionId: string): Promise<CloseRecord | null> {
    const close = await this.getClose(auctionId);
    if (close?.witness) return close;
    return null;
  }

  private async witnessSeal(
    auctionId: string,
    statement: SealStatement,
    witnessKey: string,
    closeBase: CloseRecord,
  ): Promise<CloseRecord> {
    // Another sealer may already have anchored it (ClientRequestToken dedup).
    const already = await this.getClose(auctionId);
    if (already?.witness) return already;

    const tsa = await this.tsa.sign(statement);
    let witness: WitnessBundle;
    try {
      const worm = await this.worm.put(witnessKey, { statement, tsa }, this.retentionDays);
      witness = { statement, worm, tsa };
    } catch {
      // The witness object already exists (a concurrent sealer beat us). Read
      // the authoritative copy back.
      const existing = await this.getWitness(auctionId);
      if (existing) {
        const close = await this.getClose(auctionId);
        return close ?? { ...closeBase, witness: existing, witnessTimestamp: existing.worm.storedAt };
      }
      throw new Error("failed to anchor witness and none exists");
    }

    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: pk(auctionId), SK: SK_CLOSE },
        UpdateExpression: "SET witness = :w, witnessTimestamp = :t",
        ExpressionAttributeValues: { ":w": witness, ":t": witness.worm.storedAt },
        ConditionExpression: "attribute_exists(SK)",
      }),
    );
    return { ...closeBase, witness, witnessTimestamp: witness.worm.storedAt };
  }

  async reveal(auctionId: string, input: RevealInput): Promise<{ ok: true }> {
    const bids = await this.listBids(auctionId);
    const bid = bids.find((b) => b.bidId === input.bidId);
    if (!bid) throw new NotFoundError(`bid ${input.bidId} not found`);
    if (computeCommit(input.amount, input.nonce, bid.bidderId) !== bid.commit) {
      throw new ValidationError("reveal does not match the committed value");
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: pk(auctionId), SK: skBid(bid.seq, bid.bidId) },
        UpdateExpression: "SET revealed = :t, amount = :a, nonce = :n",
        ExpressionAttributeValues: { ":t": true, ":a": input.amount, ":n": input.nonce },
        ConditionExpression: "attribute_exists(SK)",
      }),
    );
    return { ok: true };
  }

  async attemptWitnessOverwrite(auctionId: string): Promise<never> {
    const close = await this.getClose(auctionId);
    const key = close?.witnessKey ?? `auctions/${auctionId}/seal.json`;
    return this.worm.overwrite(key, { merkleRoot: "forged-by-operator" });
  }

  /**
   * Audit log. In production a DynamoDB Streams consumer projects an append-only
   * EVENT# log (see scripts/streamHandler.ts). For read resilience — and so the
   * live demo works without a deployed consumer — this derives the same events
   * deterministically from the committed items.
   */
  async listEvents(auctionId: string): Promise<AuditEvent[]> {
    const [meta, bids, close] = await Promise.all([
      this.getMeta(auctionId),
      this.listBids(auctionId),
      this.getClose(auctionId),
    ]);
    if (!meta) throw new NotFoundError(`auction ${auctionId} not found`);
    const events: AuditEvent[] = [];
    const push = (type: AuditEvent["type"], at: string, detail: AuditEvent["detail"]) =>
      events.push({ auctionId, seq: events.length, type, at, detail });

    push("AUCTION_CREATED", meta.createdAt, { title: meta.title });
    for (const b of bids) push("BID_COMMITTED", b.createdAt, { seq: b.seq, commit: b.commit, bidderId: b.bidderId });
    if (close) push("SEALED", close.sealedAt, { merkleRoot: close.merkleRoot, count: close.count });
    for (const b of bids) if (b.revealed) push("BID_REVEALED", close?.sealedAt ?? b.createdAt, { seq: b.seq, amount: b.amount ?? "" });
    return events;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the DynamoDB backend`);
  return v;
}

export function createDynamoStoreFromEnv(): LedgerStore {
  return new DynamoStore({
    table: requireEnv("MUHURI_TABLE"),
    region: process.env.AWS_REGION ?? "us-east-1",
  });
}
