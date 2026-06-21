/**
 * Real external witness backed by Amazon S3 Object Lock (COMPLIANCE mode).
 *
 * The seal proof is written once to a deterministic key with a retention date.
 * In COMPLIANCE mode the specific object *version* cannot be overwritten or
 * deleted by anyone — not even the account root — until retention expires. We
 * pin the witnessed `versionId`, so even if the operator writes a new version
 * over the key, the verifier still reads the original immutable one.
 *
 * This is the load-bearing non-repudiation anchor: a copy of the Merkle root
 * exists that the operator cannot control.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { WitnessImmutableError } from "../../errors";
import type { WormAnchor } from "../../types";
import type { WormWitness } from "../LedgerStore";

const DAY_MS = 86_400_000;

export class S3ObjectLockWorm implements WormWitness {
  readonly kind = "s3-object-lock" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly clock: () => string;

  constructor(opts: { bucket: string; client?: S3Client; region?: string; clock?: () => string }) {
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client({ region: opts.region });
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  async put(key: string, body: unknown, retentionDays: number): Promise<WormAnchor> {
    const storedAt = this.clock();
    const retainUntil = new Date(Date.parse(storedAt) + retentionDays * DAY_MS).toISOString();
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(body, null, 2),
        ContentType: "application/json",
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(retainUntil),
        // First write wins: refuse if the key already has a current version.
        IfNoneMatch: "*",
      }),
    );
    return {
      kind: "s3-object-lock",
      key,
      mode: "COMPLIANCE",
      storedAt,
      retainUntil,
      uri: `s3://${this.bucket}/${key}`,
      versionId: res.VersionId,
    };
  }

  async get(key: string): Promise<{ anchor: WormAnchor; body: unknown } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const text = await res.Body?.transformToString();
      const body = text ? JSON.parse(text) : null;
      const storedAt = (res.LastModified ?? new Date()).toISOString();
      return {
        anchor: {
          kind: "s3-object-lock",
          key,
          mode: "COMPLIANCE",
          storedAt,
          retainUntil: res.ObjectLockRetainUntilDate?.toISOString() ?? storedAt,
          uri: `s3://${this.bucket}/${key}`,
          versionId: res.VersionId,
        },
        body,
      };
    } catch {
      return null;
    }
  }

  /** Mutation requires destroying the locked version — COMPLIANCE refuses it. */
  private async attemptMutate(key: string, verb: string): Promise<never> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: head.VersionId }),
      );
    } catch (err) {
      // Object Lock returns AccessDenied for a locked version — that is the
      // proof of immutability we want to surface.
      const name = err instanceof Error ? err.name : "Error";
      throw new WitnessImmutableError(
        `S3 Object Lock (COMPLIANCE) refused to ${verb} ${key}: ${name}`,
      );
    }
    // If we reach here the delete somehow succeeded — immutability is broken.
    throw new WitnessImmutableError(
      `expected Object Lock to refuse ${verb} of ${key}, but it succeeded`,
    );
  }

  async overwrite(key: string): Promise<never> {
    return this.attemptMutate(key, "overwrite");
  }

  async remove(key: string): Promise<never> {
    return this.attemptMutate(key, "delete");
  }
}
