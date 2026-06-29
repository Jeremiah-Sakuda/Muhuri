/**
 * Parity: the EXACT invariant suite that proves MemoryStore runs against the
 * real DynamoStore too. This is the payoff of the LedgerStore abstraction — one
 * spec, both backends — and it runs in DEFAULT CI.
 *
 * By default DynamoStore runs against an in-process DynamoDB double
 * (tests/shared/FakeDynamo) that faithfully enforces ConditionExpression,
 * all-or-nothing TransactWriteItems, a synchronous (serializable) critical
 * section, and ClientRequestToken idempotency. So the marquee atomic-seal path —
 * the real TransactWriteItems calls, the count guard, the retry loop — executes
 * on every `npm test`, no longer hidden behind `describe.skip`.
 *
 * Opt MUHURI_TEST_DYNAMO=1 to point the SAME suite at a real (or DynamoDB-Local)
 * table instead — proof against genuine AWS semantics:
 *
 *   # terminal 1
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   # terminal 2
 *   AWS_REGION=us-east-1 DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
 *     MUHURI_TABLE=Muhuri MUHURI_TEST_DYNAMO=1 npm test -- parity
 *
 * Opt MUHURI_TEST_S3=1 (with a real Object-Lock bucket via MUHURI_WITNESS_BUCKET)
 * to run the witness-immutability property against REAL S3 Object Lock COMPLIANCE
 * instead of the in-memory WORM.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@/lib/store/DynamoStore";
import { MemoryWorm } from "@/lib/store/witness/MemoryWorm";
import { S3ObjectLockWorm } from "@/lib/store/witness/S3ObjectLockWorm";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import type { WormWitness } from "@/lib/store/LedgerStore";
import { FakeDynamoDocClient } from "./shared/FakeDynamo";
import { invariantSuite } from "./shared/invariantSuite";

const useRealDynamo = process.env.MUHURI_TEST_DYNAMO === "1";
const useRealS3 = process.env.MUHURI_TEST_S3 === "1";
const region = process.env.AWS_REGION ?? "us-east-1";
const table = process.env.MUHURI_TABLE ?? "Muhuri";
const bucket = process.env.MUHURI_WITNESS_BUCKET;

// A real client is shared across the suite (items are keyed by random ids, so no
// collisions); the in-process double is created fresh per harness for isolation.
const sharedRealDoc = useRealDynamo
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region, endpoint: process.env.DYNAMODB_ENDPOINT }), {
      marshallOptions: { removeUndefinedValues: true },
    })
  : null;

const label = useRealDynamo
  ? useRealS3
    ? "dynamo (live) + real S3 Object Lock"
    : "dynamo (live)"
  : "dynamo (in-process double)";

invariantSuite(label, () => {
  if (useRealS3 && !bucket) {
    throw new Error("MUHURI_TEST_S3=1 requires MUHURI_WITNESS_BUCKET");
  }
  const doc =
    sharedRealDoc ?? (new FakeDynamoDocClient() as unknown as DynamoDBDocumentClient);
  const worm: WormWitness =
    useRealS3 && bucket ? new S3ObjectLockWorm({ bucket, region }) : new MemoryWorm();
  const tsa = new Ed25519Tsa();
  const store = new DynamoStore({ table, region, doc, worm, tsa });
  return { store, worm };
});
