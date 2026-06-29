/**
 * In-process DynamoDB Document-client double.
 *
 * This is NOT a mock that records calls — it is a faithful re-implementation of
 * the exact subset of DynamoDB semantics that DynamoStore relies on, so the REAL
 * DynamoStore code (its TransactWriteItems, ConditionExpressions, count guard and
 * retry loop) executes against it unchanged. It exists so the marquee atomic-seal
 * path runs in default CI instead of `describe.skip` behind a live-AWS gate.
 *
 * What it enforces — the three load-bearing properties:
 *   1. Conditional writes genuinely reject (attribute_exists / attribute_not_exists
 *      / equality guards) with ConditionalCheckFailedException.
 *   2. TransactWriteItems is all-or-nothing: every item's condition is checked
 *      first; if any fails, NOTHING is written and TransactionCanceledException is
 *      thrown — exactly the names DynamoStore branches on.
 *   3. The mutate is a synchronous critical section (no await between
 *      read-check-write), so two concurrent seals cannot both flip OPEN->CLOSED —
 *      mirroring DynamoDB's serializable transactions in single-threaded JS.
 *   plus ClientRequestToken idempotency for the seal.
 *
 * It deliberately covers only the commands/expressions DynamoStore uses and
 * throws loudly on anything else, so it can never silently diverge from the store.
 */
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

type Item = Record<string, unknown>;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

class ConditionalCheckFailedException extends Error {
  constructor(message = "The conditional request failed") {
    super(message);
    this.name = "ConditionalCheckFailedException";
  }
}
class TransactionCanceledException extends Error {
  constructor(message = "Transaction cancelled, please refer cancellation reasons for specific reasons") {
    super(message);
    this.name = "TransactionCanceledException";
  }
}

/** JSON round-trip clone — also drops `undefined` like marshall removeUndefinedValues. */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function resolveName(token: string, names: Record<string, string> = {}): string {
  return token.startsWith("#") ? names[token] ?? token : token;
}

/**
 * Evaluate a ConditionExpression against the current item (undefined = absent).
 * Supports exactly the clauses DynamoStore emits: attribute_exists(X),
 * attribute_not_exists(X), and conjunctions of `NAME = :value`.
 */
function conditionHolds(
  expr: string | undefined,
  item: Item | undefined,
  names: Record<string, string> = {},
  values: Record<string, unknown> = {},
): boolean {
  if (!expr) return true;
  for (const raw of expr.split(/\s+AND\s+/i)) {
    const clause = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^attribute_not_exists\(\s*([#\w]+)\s*\)$/))) {
      const attr = resolveName(m[1], names);
      if (item && item[attr] !== undefined) return false;
    } else if ((m = clause.match(/^attribute_exists\(\s*([#\w]+)\s*\)$/))) {
      const attr = resolveName(m[1], names);
      if (!item || item[attr] === undefined) return false;
    } else if ((m = clause.match(/^([#\w]+)\s*=\s*(:[\w]+)$/))) {
      const attr = resolveName(m[1], names);
      if (!item || item[attr] !== values[m[2]]) return false;
    } else {
      throw new Error(`FakeDynamo: unsupported condition clause: "${clause}"`);
    }
  }
  return true;
}

/** Apply a `SET a = :x, #b = :y` UpdateExpression in place. */
function applySet(
  item: Item,
  expr: string,
  names: Record<string, string> = {},
  values: Record<string, unknown> = {},
): void {
  const m = expr.match(/^\s*SET\s+(.+)$/i);
  if (!m) throw new Error(`FakeDynamo: unsupported update expression: "${expr}"`);
  for (const assignment of m[1].split(",")) {
    const [lhs, rhs] = assignment.split("=").map((s) => s.trim());
    if (!lhs || !rhs?.startsWith(":")) {
      throw new Error(`FakeDynamo: unsupported assignment: "${assignment}"`);
    }
    item[resolveName(lhs, names)] = clone(values[rhs]);
  }
}

/** Compound primary key, joined with a separator absent from any real key. */
function keyOf(k: { PK: unknown; SK: unknown }): string {
  return `${String(k.PK)}::${String(k.SK)}`;
}

/**
 * Quacks like a DynamoDBDocumentClient for the commands DynamoStore issues.
 * One instance == one table namespace; create a fresh one per test for isolation.
 */
export class FakeDynamoDocClient {
  /** TableName -> "PK::SK" -> item. */
  private readonly tables = new Map<string, Map<string, Item>>();
  /** ClientRequestToken -> cached result, for idempotent transactions. */
  private readonly tokens = new Map<string, unknown>();

  private table(name: string): Map<string, Item> {
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new Map()));
    return t;
  }

  async send(command: Any): Promise<Any> {
    const i: Any = command?.input;

    if (command instanceof GetCommand) {
      const item = this.table(i.TableName).get(keyOf(i.Key));
      return { Item: item ? clone(item) : undefined };
    }

    if (command instanceof PutCommand) {
      // --- synchronous critical section ---
      const t = this.table(i.TableName);
      const key = keyOf(i.Item);
      if (!conditionHolds(i.ConditionExpression, t.get(key), i.ExpressionAttributeNames, i.ExpressionAttributeValues)) {
        throw new ConditionalCheckFailedException();
      }
      t.set(key, clone(i.Item));
      return {};
    }

    if (command instanceof UpdateCommand) {
      // --- synchronous critical section ---
      const t = this.table(i.TableName);
      const key = keyOf(i.Key);
      const existing = t.get(key);
      if (!conditionHolds(i.ConditionExpression, existing, i.ExpressionAttributeNames, i.ExpressionAttributeValues)) {
        throw new ConditionalCheckFailedException();
      }
      const item = existing ? clone(existing) : { ...i.Key };
      applySet(item, i.UpdateExpression, i.ExpressionAttributeNames, i.ExpressionAttributeValues);
      t.set(key, item);
      return {};
    }

    if (command instanceof QueryCommand) {
      const values: Record<string, unknown> = i.ExpressionAttributeValues ?? {};
      const pkVal = values[":pk"];
      const prefix = values[":bid"] as string | undefined;
      const items = [...this.table(i.TableName).values()]
        .filter(
          (it) =>
            it.PK === pkVal &&
            typeof it.SK === "string" &&
            (prefix === undefined || (it.SK as string).startsWith(prefix)),
        )
        .sort((a, b) => String(a.SK).localeCompare(String(b.SK)))
        .map((it) => clone(it));
      return { Items: items, LastEvaluatedKey: undefined };
    }

    if (command instanceof TransactWriteCommand) {
      return this.transact(i);
    }

    throw new Error(`FakeDynamo: unsupported command ${command?.constructor?.name ?? typeof command}`);
  }

  private transact(input: Any): unknown {
    // Idempotency: a transaction replayed with the same token returns the
    // original result without re-applying (models ClientRequestToken).
    if (input.ClientRequestToken && this.tokens.has(input.ClientRequestToken)) {
      return this.tokens.get(input.ClientRequestToken);
    }

    // --- synchronous critical section: check ALL, then apply ALL ---
    // Phase 1 — every condition must hold against the CURRENT state.
    for (const ti of input.TransactItems) {
      const op = ti.Put ?? ti.Update;
      if (!op) throw new Error("FakeDynamo: only Put/Update transact items are supported");
      const t = this.table(op.TableName);
      const key = keyOf(ti.Put ? ti.Put.Item : op.Key);
      if (!conditionHolds(op.ConditionExpression, t.get(key), op.ExpressionAttributeNames, op.ExpressionAttributeValues)) {
        throw new TransactionCanceledException();
      }
    }
    // Phase 2 — all conditions held: apply atomically.
    for (const ti of input.TransactItems) {
      if (ti.Put) {
        this.table(ti.Put.TableName).set(keyOf(ti.Put.Item), clone(ti.Put.Item));
      } else {
        const u = ti.Update;
        const t = this.table(u.TableName);
        const key = keyOf(u.Key);
        const item = t.has(key) ? clone(t.get(key)!) : { ...u.Key };
        applySet(item, u.UpdateExpression, u.ExpressionAttributeNames, u.ExpressionAttributeValues);
        t.set(key, item);
      }
    }

    const result = {};
    if (input.ClientRequestToken) this.tokens.set(input.ClientRequestToken, result);
    return result;
  }
}
