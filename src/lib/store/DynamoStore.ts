/**
 * Real DynamoDB-backed LedgerStore.
 *
 * Fleshed out in the DynamoStore phase: single-table design, the atomic
 * two-item seal via TransactWriteItems + ConditionExpression + ClientRequestToken,
 * a DynamoDB Streams audit projection, and a real S3 Object Lock (COMPLIANCE)
 * witness. Until then this throws if selected, and the app defaults to memory.
 */
import type { LedgerStore } from "./LedgerStore";

export function createDynamoStoreFromEnv(): LedgerStore {
  throw new Error(
    "DynamoStore is not configured yet. Run with MUHURI_BACKEND=memory, or " +
      "complete the DynamoStore phase and set MUHURI_TABLE / MUHURI_WITNESS_BUCKET / AWS_REGION.",
  );
}
