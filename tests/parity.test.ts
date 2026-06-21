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
 * The S3 Object Lock witness can't run locally, so parity uses the in-memory
 * WORM witness here (S3 immutability is covered by the invariant suite against
 * MemoryWorm and verified manually against real S3 on deploy).
 */
import { describe, it, beforeAll } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@/lib/store/DynamoStore";
import { MemoryWorm } from "@/lib/store/witness/MemoryWorm";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import { invariantSuite } from "./shared/invariantSuite";

if (process.env.MUHURI_TEST_DYNAMO === "1") {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const table = process.env.MUHURI_TABLE ?? "Muhuri";
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region, endpoint }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  invariantSuite("dynamo", () => {
    const worm = new MemoryWorm();
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
