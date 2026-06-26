/**
 * Independent timestamp authority.
 *
 * This is the second witness in the quorum, and it is *designed* to close the
 * strongest gap in the "external witness" story: S3 Object Lock lives in the
 * operator's own AWS account; an independent timestamp authority would not. It
 * co-signs {merkleRoot, sealedAt} so that — once its key lives outside the
 * operator — the operator cannot fabricate a timestamp for a different root.
 * The standalone verifier checks the Ed25519 detached signature offline against
 * an independently-pinned public key — no ASN.1, no network, no AWS credentials.
 *
 * IN THIS BUILD the key is operator-held (a deterministic demo fixture; see
 * demoTsaKey.ts), so independence is the production goal, not yet a property of
 * this build. Production runs the keypair in a separate trust domain (its own
 * Lambda / KMS key, or a real public TSA), loaded here from a PEM.
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
