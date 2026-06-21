/**
 * DynamoDB Streams → append-only audit projection.
 *
 * Deploy this as a Lambda on the table's stream (NEW_AND_OLD_IMAGES). It turns
 * every base-table write into an immutable EVENT# item under the same partition
 * key, giving a tamper-evident audit log of exactly what happened and when:
 * auction created, each bid committed, each reveal, and the seal.
 *
 * The live app derives the same log on read for resilience (DynamoStore
 * .listEvents), so the demo works whether or not this consumer is deployed —
 * but in production this is the source of truth for the audit trail.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

interface StreamRecord {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  dynamodb?: {
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
    ApproximateCreationDateTime?: number;
    SequenceNumber?: string;
  };
}
interface StreamEvent {
  Records: StreamRecord[];
}

const table = process.env.MUHURI_TABLE ?? "Muhuri";
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

type Img = Record<string, unknown>;

function project(record: StreamRecord): Img | null {
  const img = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage as never) : null;
  const old = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage as never) : null;
  if (!img) return null;
  const sk = String(img.SK ?? "");
  const at = new Date((record.dynamodb?.ApproximateCreationDateTime ?? Date.now() / 1000) * 1000).toISOString();

  let eventType: string | null = null;
  let detail: Record<string, unknown> = {};
  if (sk === "META" && record.eventName === "INSERT") {
    eventType = "AUCTION_CREATED";
    detail = { title: img.title };
  } else if (sk.startsWith("BID#") && record.eventName === "INSERT") {
    eventType = "BID_COMMITTED";
    detail = { seq: img.seq, commit: img.commit, bidderId: img.bidderId };
  } else if (sk.startsWith("BID#") && record.eventName === "MODIFY" && !old?.revealed && img.revealed) {
    eventType = "BID_REVEALED";
    detail = { seq: img.seq, amount: img.amount };
  } else if (sk === "CLOSE" && record.eventName === "INSERT") {
    eventType = "SEALED";
    detail = { merkleRoot: img.merkleRoot, count: img.count };
  }
  if (!eventType) return null;

  return {
    PK: img.PK,
    SK: `EVENT#${at}#${record.dynamodb?.SequenceNumber ?? ""}`,
    type: "event",
    eventType,
    at,
    detail,
  };
}

export async function handler(event: StreamEvent): Promise<void> {
  for (const record of event.Records) {
    const item = project(record);
    if (item) {
      await doc.send(new PutCommand({ TableName: table, Item: item }));
    }
  }
}
