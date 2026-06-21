/**
 * Isomorphic (Web Crypto) bid commitment for the browser.
 *
 * This MUST stay byte-identical to `computeCommit` in crypto.ts so a commit
 * made in the bidder's browser matches what the server chains and seals — the
 * amount is hashed client-side and never sent until reveal. A cross-check test
 * (tests/commit-browser.test.ts) runs both in Node and asserts they agree.
 */
const enc = new TextEncoder();

function canonicalConcat(domain: string, fields: string[]): string {
  // `${utf8ByteLength}:${field}` matches Buffer.byteLength(field, "utf8").
  const parts = fields.map((f) => `${enc.encode(f).length}:${f}`);
  return `${domain} ${parts.join(" ")}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** commit = SHA256(amount ‖ nonce ‖ bidderId), computed in the browser. */
export async function browserComputeCommit(
  amount: string,
  nonce: string,
  bidderId: string,
): Promise<string> {
  return sha256Hex(canonicalConcat("muhuri.commit.v1", [amount, nonce, bidderId]));
}

/** Cryptographically random hex nonce, browser-side. */
export function browserRandomNonce(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
