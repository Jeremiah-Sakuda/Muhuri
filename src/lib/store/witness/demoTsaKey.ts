/**
 * Derives the demo timestamp-authority private key (server-side only).
 *
 * Deterministic from a public phrase, so the public half matches the pinned
 * key in tsa-pinned.ts and honest local seals verify with zero setup. This is a
 * FIXTURE, not a secret — production must supply MUHURI_TSA_PRIVATE_KEY whose
 * private half lives outside the operator (e.g. a KMS asymmetric key).
 */
import { createHash, createPrivateKey } from "node:crypto";

const PHRASE = "muhuri-demo-timestamp-authority-v1";
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

export function demoTsaPrivateKeyPem(): string {
  const seed = createHash("sha256").update(PHRASE).digest();
  const der = Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
}
