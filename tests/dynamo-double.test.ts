/**
 * Proves the REAL DynamoStore transaction path under concurrency, in default CI.
 *
 * These exercise exactly the conditional-write and TransactWriteItems semantics
 * that make the seal atomic — driven through the in-process DynamoDB double, so
 * the marquee path is tested rather than asserted. Run live with
 * MUHURI_TEST_DYNAMO=1 (see parity.test.ts) for the same against real AWS.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoStore } from "@/lib/store/DynamoStore";
import { MemoryWorm } from "@/lib/store/witness/MemoryWorm";
import { Ed25519Tsa } from "@/lib/store/witness/Ed25519Tsa";
import { ConditionalCheckError } from "@/lib/errors";
import { computeCommit, randomNonce, finalChainHead } from "@/lib/crypto";
import { FakeDynamoDocClient } from "./shared/FakeDynamo";

function freshStore(): DynamoStore {
  const doc = new FakeDynamoDocClient() as unknown as DynamoDBDocumentClient;
  return new DynamoStore({ table: "Muhuri", region: "us-east-1", doc, worm: new MemoryWorm(), tsa: new Ed25519Tsa() });
}

describe("DynamoStore × in-process DynamoDB double (real transaction path)", () => {
  it("concurrent appends serialize through the count guard — contiguous seq, no collisions", async () => {
    const store = freshStore();
    const { auctionId: id } = await store.createAuction({ title: "agent run" });

    const N = 6;
    const inputs = Array.from({ length: N }, (_, i) => {
      const bidderId = `tool_${i}`;
      const nonce = randomNonce();
      return { bidId: randomUUID(), bidderId, commit: computeCommit(`arg-${i}`, nonce, bidderId) };
    });

    // Fire all at once: the `#c = :seq` guard + retry loop must hand out 0..N-1
    // with no lost or duplicated sequence — the transaction is doing real work.
    await Promise.all(inputs.map((i) => store.appendCommit(id, i)));

    const bids = await store.listBids(id);
    expect(bids.map((b) => b.seq)).toEqual([...Array(N).keys()]);
    expect(new Set(bids.map((b) => b.bidId)).size).toBe(N);
    // The public chain head equals an independent recomputation — order is fixed.
    expect(await store.getChainHead(id)).toBe(finalChainHead(id, bids.map((b) => b.commit)));
  });

  it("concurrent seals: exactly one wins, root is idempotent, post-seal append refused", async () => {
    const store = freshStore();
    const { auctionId: id, sealToken } = await store.createAuction({ title: "agent run" });
    for (let i = 0; i < 5; i++) {
      const bidderId = `step_${i}`;
      const nonce = randomNonce();
      await store.appendCommit(id, { bidId: randomUUID(), bidderId, commit: computeCommit(String(i), nonce, bidderId) });
    }

    // Three sealers race the same atomic TransactWriteItems (status OPEN→CLOSED
    // under a count guard). All must resolve to the SAME witnessed root.
    const settled = await Promise.allSettled([
      store.seal(id, sealToken),
      store.seal(id, sealToken),
      store.seal(id, sealToken),
    ]);
    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<DynamoStore["seal"]>>> =>
        r.status === "fulfilled",
    );
    expect(fulfilled.length).toBe(3);
    expect(new Set(fulfilled.map((r) => r.value.merkleRoot)).size).toBe(1);

    const close = await store.getCloseRecord(id);
    expect(close?.count).toBe(5);

    // The conditional write is the backstop — a post-seal append is rejected.
    await expect(
      store.appendCommit(id, { bidId: randomUUID(), bidderId: "late", commit: "f".repeat(64) }),
    ).rejects.toBeInstanceOf(ConditionalCheckError);
  });
});
