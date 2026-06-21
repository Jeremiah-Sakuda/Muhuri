/**
 * In-memory write-once witness. Faithfully reproduces the load-bearing
 * property of S3 Object Lock (COMPLIANCE mode): once an object is written it
 * cannot be overwritten or deleted by anyone — not even the operator — until
 * retention expires. This lets the full app and demo run with zero cloud deps
 * while still upholding the non-repudiation invariant.
 */
import { WitnessImmutableError } from "../../errors";
import type { WormAnchor } from "../../types";
import type { WormWitness } from "../LedgerStore";

const DAY_MS = 86_400_000;

export class MemoryWorm implements WormWitness {
  readonly kind = "memory-worm" as const;
  private readonly objects = new Map<string, { anchor: WormAnchor; body: unknown }>();
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  async put(key: string, body: unknown, retentionDays: number): Promise<WormAnchor> {
    // First write wins; a second PutObject to the same locked key is refused.
    if (this.objects.has(key)) {
      throw new WitnessImmutableError(
        `object ${key} already exists under COMPLIANCE retention`,
      );
    }
    const storedAt = this.clock();
    const retainUntil = new Date(Date.parse(storedAt) + retentionDays * DAY_MS).toISOString();
    const anchor: WormAnchor = {
      kind: "memory-worm",
      key,
      mode: "COMPLIANCE",
      storedAt,
      retainUntil,
      uri: `worm://memory/${key}`,
    };
    this.objects.set(key, { anchor, body: structuredClone(body) });
    return anchor;
  }

  async get(key: string): Promise<{ anchor: WormAnchor; body: unknown } | null> {
    const entry = this.objects.get(key);
    return entry ? { anchor: entry.anchor, body: structuredClone(entry.body) } : null;
  }

  async overwrite(key: string): Promise<never> {
    throw new WitnessImmutableError(
      `object ${key} is under COMPLIANCE retention and cannot be overwritten`,
    );
  }

  async remove(key: string): Promise<never> {
    throw new WitnessImmutableError(
      `object ${key} is under COMPLIANCE retention and cannot be deleted`,
    );
  }
}
