/**
 * Independent timestamp authority.
 *
 * This is the second witness in the quorum, and it closes the strongest gap in
 * the "external witness" story: S3 Object Lock lives in the operator's own AWS
 * account. A timestamp authority does not. It holds a signing key the operator
 * never sees and co-signs {merkleRoot, sealedAt}, so the operator cannot
 * fabricate a timestamp for a different root. This models RFC-3161 /
 * OpenTimestamps with an Ed25519 detached signature that the standalone
 * verifier checks offline against the published public key — no ASN.1, no
 * network, no AWS credentials.
 *
 * In production the keypair lives in a separate trust domain (its own Lambda /
 * KMS key, or a real public TSA). Here it is generated per-process for memory
 * and can be loaded from a PEM for the deployed signer.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { tsaSignedMessage } from "../../crypto";
import type { SealStatement, TsaAnchor } from "../../types";
import type { TimestampAuthority } from "../LedgerStore";

export interface Ed25519TsaOptions {
  kind?: TsaAnchor["kind"];
  authority?: string;
  /** PKCS#8 PEM private key; if omitted a fresh keypair is generated. */
  privateKeyPem?: string;
  clock?: () => string;
}

export class Ed25519Tsa implements TimestampAuthority {
  readonly kind: TsaAnchor["kind"];
  private readonly priv: KeyObject;
  private readonly pubB64: string;
  private readonly authority: string;
  private readonly clock: () => string;

  constructor(opts: Ed25519TsaOptions = {}) {
    this.kind = opts.kind ?? "memory-tsa";
    this.authority = opts.authority ?? "Muhuri timestamp authority (local)";
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.priv = opts.privateKeyPem
      ? createPrivateKey(opts.privateKeyPem)
      : generateKeyPairSync("ed25519").privateKey;
    this.pubB64 = createPublicKey(this.priv)
      .export({ type: "spki", format: "der" })
      .toString("base64");
  }

  publicKey(): string {
    return this.pubB64;
  }

  async sign(statement: SealStatement): Promise<TsaAnchor> {
    const signedAt = this.clock();
    const msg = Buffer.from(tsaSignedMessage(statement, signedAt), "utf8");
    const signature = sign(null, msg, this.priv).toString("base64");
    return {
      kind: this.kind,
      authority: this.authority,
      algorithm: "ed25519",
      publicKey: this.pubB64,
      signature,
      signedAt,
    };
  }
}
