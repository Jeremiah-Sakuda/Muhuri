/**
 * Isomorphic (Web Crypto) port of the cryptographic core.
 *
 * MUST stay byte-identical to crypto.ts: same domain tags, same length-prefixed
 * canonical encoding, same SHA-256. tests/crypto-browser.test.ts runs these in
 * Node and asserts they equal the node functions. This is what lets the
 * verifier run entirely in the browser — no server round-trip, so "Wi-Fi off"
 * is literally true.
 */
const enc = new TextEncoder();

const DOMAIN = {
  commit: "muhuri.commit.v1",
  chainZero: "muhuri.chain0.v1",
  chainNext: "muhuri.chain.v1",
  merkleLeaf: "muhuri.merkle.leaf.v1",
  merkleNode: "muhuri.merkle.node.v1",
  merkleEmpty: "muhuri.merkle.empty.v1",
  seal: "muhuri.seal.v1",
  tsa: "muhuri.tsa.v1",
} as const;

function canonicalConcat(domain: string, fields: string[]): string {
  const parts = fields.map((f) => `${enc.encode(f).length}:${f}`);
  return `${domain} ${parts.join(" ")}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function browserComputeCommit(
  amount: string,
  nonce: string,
  bidderId: string,
): Promise<string> {
  return sha256Hex(canonicalConcat(DOMAIN.commit, [amount, nonce, bidderId]));
}

export function browserRandomNonce(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hashLeaf(commit: string): Promise<string> {
  return sha256Hex(canonicalConcat(DOMAIN.merkleLeaf, [commit]));
}
function hashNode(left: string, right: string): Promise<string> {
  return sha256Hex(canonicalConcat(DOMAIN.merkleNode, [left, right]));
}

export async function browserMerkleRoot(commits: string[]): Promise<string> {
  if (commits.length === 0) return sha256Hex(canonicalConcat(DOMAIN.merkleEmpty, []));
  let level = await Promise.all(commits.map(hashLeaf));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(await hashNode(left, right));
    }
    level = next;
  }
  return level[0];
}

export function browserChainHeadZero(auctionId: string): Promise<string> {
  return sha256Hex(canonicalConcat(DOMAIN.chainZero, [auctionId]));
}

export async function browserFinalChainHead(
  auctionId: string,
  commits: string[],
): Promise<string> {
  let head = await browserChainHeadZero(auctionId);
  for (let i = 0; i < commits.length; i++) {
    head = await sha256Hex(canonicalConcat(DOMAIN.chainNext, [head, commits[i], String(i)]));
  }
  return head;
}

interface SealStatementLike {
  auctionId: string;
  merkleRoot: string;
  finalChainHead: string;
  count: number;
  sealedAt: string;
}

export function browserCanonicalSealStatement(s: SealStatementLike): string {
  return canonicalConcat(DOMAIN.seal, [
    s.auctionId,
    s.merkleRoot,
    s.finalChainHead,
    String(s.count),
    s.sealedAt,
  ]);
}

export function browserTsaSignedMessage(s: SealStatementLike, signedAt: string): string {
  return canonicalConcat(DOMAIN.tsa, [browserCanonicalSealStatement(s), signedAt]);
}
