/**
 * Provision the AWS resources Muhuri's dynamo backend needs. Idempotent — safe
 * to re-run. Creates:
 *   1. The single DynamoDB table (PK/SK, on-demand) with Streams enabled.
 *   2. The S3 witness bucket with Object Lock (COMPLIANCE-capable).
 *   3. A stable Ed25519 keypair for the timestamp authority (printed once).
 *
 *   AWS_REGION=us-east-1 MUHURI_TABLE=Muhuri MUHURI_WITNESS_BUCKET=my-bucket \
 *     npm run setup:dynamo
 */
import { generateKeyPairSync } from "node:crypto";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectLockConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION ?? "us-east-1";
const table = process.env.MUHURI_TABLE ?? "Muhuri";
const bucket =
  process.env.MUHURI_WITNESS_BUCKET ?? `muhuri-witness-${region}-${Date.now().toString(36)}`;

const ddb = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

async function ensureTable(): Promise<void> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: table }));
    console.log(`✓ table ${table} already exists`);
    return;
  } catch {
    /* create below */
  }
  await ddb.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
    }),
  );
  console.log(`✓ created table ${table} (on-demand, Streams: NEW_AND_OLD_IMAGES)`);
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`✓ witness bucket ${bucket} already exists`);
    return;
  } catch {
    /* create below */
  }
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ObjectLockEnabledForBucket: true,
      ...(region === "us-east-1"
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
    }),
  );
  // Object Lock requires versioning; CreateBucket enables it, but assert it.
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );
  await s3.send(
    new PutObjectLockConfigurationCommand({
      Bucket: bucket,
      ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" },
    }),
  );
  console.log(`✓ created witness bucket ${bucket} (Object Lock enabled)`);
}

function printTsaKey(): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  console.log("\n--- timestamp authority key (set MUHURI_TSA_PRIVATE_KEY; publish the public key) ---");
  console.log("public key (base64 SPKI):", pubB64);
  console.log(pem.trim());
}

async function main(): Promise<void> {
  console.log(`Provisioning Muhuri in ${region}…\n`);
  await ensureTable();
  await ensureBucket();
  printTsaKey();
  console.log("\n--- set these environment variables (Vercel + local) ---");
  console.log(`AWS_REGION=${region}`);
  console.log(`MUHURI_BACKEND=dynamo`);
  console.log(`MUHURI_TABLE=${table}`);
  console.log(`MUHURI_WITNESS_BUCKET=${bucket}`);
  console.log("MUHURI_TSA_PRIVATE_KEY=<the PEM printed above>");
  console.log("(plus AWS credentials for the deployment)\n");
}

main().catch((err) => {
  console.error("setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
