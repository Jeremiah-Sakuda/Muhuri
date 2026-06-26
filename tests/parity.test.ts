/**
 * Parity: the EXACT invariant suite that proves MemoryStore runs against the
 * real DynamoStore too. This is the payoff of the LedgerStore abstraction — one
 * spec, both backends.
 *
 * Gated on MUHURI_TEST_DYNAMO=1 because it needs a real (or local) DynamoDB
 * table. Point it at DynamoDB Local for a free run:
 *
 *   # terminal 1
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   # terminal 2
 *   AWS_REGION=us-east-1 DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
 *     MUHURI_TABLE=Muhuri MUHURI_TEST_DYNAMO=1 npm test -- parity
 *
 * Opt MUHURI_TEST_S3=1 (with a real Object-Lock bucket via MUHURI_WITNESS_BUCKET)
 * to run the "witness immutability" property against REAL S3 — the COMPLIANCE
 * overwrite/delete refusal — instead of the in-memory WORM:
 *
 *   AWS_REGION=us-east-1 MUHURI_TABLE=Muhuri MUHURI_WITNESS_BUCKET=<bucket> \
 *     MUHURI_TEST_DYNAMO=1 MUHURI_TEST_S3=1 npm test -- parity
 *
 * (DynamoDB Local can't do S3 Object Lock, so the S3 path needs a real bucket.)
 */
import { describe, it, beforeAll } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@/lib/store/DynamoStore";
import { MemoryWorm } from "@/lib/store/witness/MemoryWorm";
import { S3ObjectLockWorm } from "@/lib/store/witness/S3ObjectLockWorm";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import type { WormWitness } from "@/lib/store/LedgerStore";
import { invariantSuite } from "./shared/invariantSuite";

if (process.env.MUHURI_TEST_DYNAMO === "1") {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const table = process.env.MUHURI_TABLE ?? "Muhuri";
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const useRealS3 = process.env.MUHURI_TEST_S3 === "1";
  const bucket = process.env.MUHURI_WITNESS_BUCKET;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region, endpoint }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  // When MUHURI_TEST_S3=1, the witness-immutability property runs against real
  // S3 Object Lock (COMPLIANCE) — exercising the actual overwrite/delete refusal.
  const label = useRealS3 ? "dynamo + real S3 Object Lock" : "dynamo";
  invariantSuite(label, () => {
    if (useRealS3 && !bucket) {
      throw new Error("MUHURI_TEST_S3=1 requires MUHURI_WITNESS_BUCKET");
    }
    const worm: WormWitness =
      useRealS3 && bucket ? new S3ObjectLockWorm({ bucket, region }) : new MemoryWorm();
    const tsa = new Ed25519Tsa();
    const store = new DynamoStore({ table, region, doc, worm, tsa });
    return { store, worm };
  });
} else {
  describe.skip("invariants [dynamo]", () => {
    beforeAll(() => undefined);
    it("set MUHURI_TEST_DYNAMO=1 (and a DynamoDB endpoint) to run parity", () => undefined);
  });
}
