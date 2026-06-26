/**
 * The "perfect crime", staged client-side.
 *
 * `forgeWinningBid` does what a malicious operator would: pick the winning bid,
 * rewrite its amount, and rebuild EVERYTHING they control — the commit, the
 * Merkle root, the chain head — then re-sign the forged statement with a fresh
 * key the operator owns. The result is internally flawless.
 *
 * `operatorConsistencyCheck` models the operator's own dashboard: it checks the
 * records against THEMSELVES (and the bundle's own key), so a forgery passes it
 * — "all records consistent." The independent verifier (verifier.browser.ts),
 * which checks against the pinned authority key, is what catches it.
 */
import { getPublicKeyAsync, signAsync, utils, verifyAsync } from "@noble/ed25519";
import {
  browserComputeCommit,
  browserFinalChainHead,
  browserMerkleRoot,
  browserTsaSignedMessage,
} from "./crypto-browser";
import { b64ToBytes } from "./tsa-pinned";
import type { ProofBundle } from "./verifier";

const enc = new TextEncoder();
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function bytesToB64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function spkiB64FromRaw(raw: Uint8Array): string {
  const out = new Uint8Array(SPKI_PREFIX.length + raw.length);
  out.set(SPKI_PREFIX);
  out.set(raw, SPKI_PREFIX.length);
  return bytesToB64(out);
}

export interface ForgeResult {
  forged: ProofBundle;
  /** The action type / identity of the rewritten record. */
  label: string;
  originalDetail: string;
  newDetail: string;
}

/** Produce a plausibly-different forged value for a record's detail. */
function forgeDetail(original: string): string {
  const m = original.match(/[\d][\d,]*(\.\d+)?/);
  if (m) {
    const num = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(num) && num > 0) {
      return original.replace(m[0], String(Math.max(1, Math.round(num / 10))));
    }
  }
  return `${original} (edited)`;
}

/** Rewrite the most consequential record and rebuild a self-consistent bundle. */
export async function forgeWinningBid(bundle: ProofBundle): Promise<ForgeResult> {
  const forged: ProofBundle = structuredClone(bundle);
  const revealed = forged.bids.filter((b) => b.amount !== undefined && b.nonce !== undefined);
  // Prefer the most consequential record to rewrite: a payment/execute action,
  // then a currency amount, then any large number, else the last revealed.
  const target =
    revealed.find((b) => /payment|execute|transfer|wire/i.test(b.bidderId)) ??
    revealed.find((b) => /\$/.test(b.amount ?? "")) ??
    revealed.find((b) => /\d{3,}/.test(b.amount ?? "")) ??
    revealed[revealed.length - 1] ??
    forged.bids[0];

  const originalDetail = target.amount ?? "";
  const newDetail = forgeDetail(originalDetail);
  const nonce = target.nonce ?? "0";

  // Rewrite the record and rebuild everything the operator controls.
  target.amount = newDetail;
  target.commit = await browserComputeCommit(newDetail, nonce, target.bidderId);
  const commits = forged.bids.map((b) => b.commit);
  forged.witness.statement.merkleRoot = await browserMerkleRoot(commits);
  forged.witness.statement.finalChainHead = await browserFinalChainHead(forged.auctionId, commits);

  // Re-sign the forged statement with a fresh key the OPERATOR owns.
  const sk = utils.randomSecretKey();
  const pk = await getPublicKeyAsync(sk);
  const signedAt = forged.witness.statement.sealedAt;
  const msg = enc.encode(browserTsaSignedMessage(forged.witness.statement, signedAt));
  const sig = await signAsync(msg, sk);
  forged.witness.tsa = {
    kind: "ed25519-tsa",
    authority: "Operator's own key (forged)",
    algorithm: "ed25519",
    publicKey: spkiB64FromRaw(pk),
    signature: bytesToB64(sig),
    signedAt,
  };

  return { forged, label: target.bidderId, originalDetail, newDetail };
}

export interface OperatorCheck {
  label: string;
  ok: boolean;
}

/** The operator's own console — checks the records against themselves. */
export async function operatorConsistencyCheck(
  bundle: ProofBundle,
): Promise<{ allOk: boolean; checks: OperatorCheck[] }> {
  const s = bundle.witness.statement;
  const bids = [...bundle.bids].sort((a, b) => a.seq - b.seq);
  const commits = bids.map((b) => b.commit);

  let revealsOk = true;
  for (const b of bids) {
    if (b.amount === undefined || b.nonce === undefined) continue;
    if ((await browserComputeCommit(b.amount, b.nonce, b.bidderId)) !== b.commit) revealsOk = false;
  }
  const rootOk = (await browserMerkleRoot(commits)) === s.merkleRoot;
  const chainOk = (await browserFinalChainHead(bundle.auctionId, commits)) === s.finalChainHead;

  // Verify against the bundle's OWN key — the operator trusting their own records.
  let sigOk = false;
  try {
    const spki = b64ToBytes(bundle.witness.tsa.publicKey);
    const rawPub = spki.subarray(spki.length - 32);
    const msg = enc.encode(browserTsaSignedMessage(s, bundle.witness.tsa.signedAt));
    sigOk = await verifyAsync(b64ToBytes(bundle.witness.tsa.signature), msg, rawPub);
  } catch {
    sigOk = false;
  }

  const checks: OperatorCheck[] = [
    { label: "Reveals open their commitments", ok: revealsOk },
    { label: "Merkle root recomputes", ok: rootOk },
    { label: "Chain head recomputes", ok: chainOk },
    { label: "Signature verifies (own key)", ok: sigOk },
  ];
  return { allOk: checks.every((c) => c.ok), checks };
}
