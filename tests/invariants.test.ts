import { MemoryStore } from "@/lib/store/MemoryStore";
import { invariantSuite } from "./shared/invariantSuite";

// The same suite runs against DynamoStore in parity.test.ts.
invariantSuite("memory", () => {
  const store = new MemoryStore();
  return { store, worm: store.worm };
});
