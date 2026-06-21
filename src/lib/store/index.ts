/**
 * Backend selection. `MUHURI_BACKEND=memory|dynamo` picks the implementation;
 * the rest of the app is oblivious to which one it got.
 *
 * The instance is cached on globalThis so it survives Next.js dev hot-reloads
 * (otherwise the in-memory demo would reset on every code change). On Vercel,
 * deploy with `MUHURI_BACKEND=dynamo` so state persists across invocations and
 * the DynamoDB integration is what's actually exercised.
 */
import { MemoryStore } from "./MemoryStore";
import { createDynamoStoreFromEnv } from "./DynamoStore";
import type { LedgerStore } from "./LedgerStore";

export type { LedgerStore } from "./LedgerStore";

type Backend = "memory" | "dynamo";

const globalRef = globalThis as unknown as { __muhuriStore?: LedgerStore };

function create(): LedgerStore {
  const backend = (process.env.MUHURI_BACKEND ?? "memory").toLowerCase() as Backend;
  switch (backend) {
    case "dynamo":
      return createDynamoStoreFromEnv();
    case "memory":
    default:
      return new MemoryStore();
  }
}

export function getStore(): LedgerStore {
  if (!globalRef.__muhuriStore) globalRef.__muhuriStore = create();
  return globalRef.__muhuriStore;
}

export function backendName(): Backend {
  return (process.env.MUHURI_BACKEND ?? "memory").toLowerCase() === "dynamo"
    ? "dynamo"
    : "memory";
}
