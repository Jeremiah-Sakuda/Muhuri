/**
 * Published timestamp-authority public keys, pinned in the verifier.
 *
 * This is the load-bearing trust decision: the verifier checks a seal's
 * signature against THESE keys — held independently — not against the public
 * key carried inside the proof bundle. That is what makes a key-swap forgery
 * fail. An operator can rebuild a self-consistent bundle and re-sign it, but
 * not with a key the verifier already trusts.
 *
 * The demo key below is deterministic and NOT secret — it's a fixture so the
 * offline demo verifies locally with zero setup. Production adds its own
 * authority key (whose private half lives in a separate trust domain, e.g. a
 * KMS asymmetric key) via MUHURI_TSA_PUBLIC_KEY.
 *
 * Isomorphic + data-only: safe to import in the browser verifier.
 */

/** Demo authority public key (base64 SPKI), derived from a public phrase. */
export const DEMO_TSA_PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEAPdljhTm4GPX60M0bUNITPr+06NAT3Vj4mzcZALAaMa8=";

function envKey(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

/** The set of authority public keys the verifier trusts. */
export function pinnedTsaPublicKeys(): string[] {
  const keys = [DEMO_TSA_PUBLIC_KEY_B64];
  // Server-side production key, and a client-exposed variant for the browser.
  for (const v of [envKey("MUHURI_TSA_PUBLIC_KEY"), envKey("NEXT_PUBLIC_MUHURI_TSA_PUBLIC_KEY")]) {
    if (v && !keys.includes(v)) keys.push(v);
  }
  return keys;
}

/** Raw 32-byte Ed25519 public key extracted from a base64 SPKI key. */
export function rawEd25519FromSpkiB64(b64: string): Uint8Array {
  const der = b64ToBytes(b64);
  // Ed25519 SPKI = 12-byte prefix (302a300506032b6570032100) + 32-byte key.
  return der.subarray(der.length - 32);
}

export function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}
