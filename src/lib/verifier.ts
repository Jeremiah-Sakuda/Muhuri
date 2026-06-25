/**
 * The standalone, offline verifier.
 *
 * This is what turns Muhuri from "trust me" into "verify me". It takes a proof
 * bundle — the externally-witnessed seal plus the revealed bids — and decides,
 * with ZERO AWS credentials and no access to the operator's database, whether
 * the sealed set is authentic. It relies only on Node's built-in crypto, so it
 * runs anywhere: a losing bidder's laptop, an auditor's CI, a court's expert.
 *
 * It performs four independent checks:
 *   1. Reveal integrity — each revealed {amount, nonce, bidderId} re-hashes to
 *      the sealed commit. A bidder cannot reveal an amount they didn't commit.
 *   2. Ordering integrity — sequence numbers are contiguous and unique.
 *   3. Root match — the Merkle root rebuilt over the ordered commits equals the
 *      externally-witnessed root. Any swap, edit, reorder, or backdate changes a
 *      leaf or its position and breaks this.
 *   4. Witness authenticity — the independent timestamp authority's signature
 *      over the witnessed statement verifies against its published key, so the
 *      operator cannot present a fabricated seal for a different root.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  computeCommit,
  finalChainHead,
  merkleRoot,
  tsaSignedMessage,
} from "./crypto";
import { pinnedTsaPublicKeys } from "./tsa-pinned";
import type { SealStatement, TsaAnchor, WitnessBundle } from "./types";

/** A bid as seen by the verifier — the sealed commit, plus the reveal if given. */
export interface RevealedBid {
  seq: number;
  bidId: string;
  bidderId: string;
  commit: string;
  amount?: string;
  nonce?: string;
}

/** The self-contained artifact an outsider verifies. */
export interface ProofBundle {
  auctionId: string;
  witness: WitnessBundle;
  bids: RevealedBid[];
}

export interface BadReveal {
  seq: number;
  bidId: string;
  reason: string;
}

export interface VerificationCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  valid: boolean;
  auctionId: string;
  recomputedRoot: string;
  witnessedRoot: string;
  rootMatches: boolean;
  recomputedFinalChainHead: string;
  witnessedFinalChainHead: string;
  chainMatches: boolean;
  tsaValid: boolean;
  tsaTimeConsistent: boolean;
  tsaAuthority: string;
  countMatches: boolean;
  orderingOk: boolean;
  badReveals: BadReveal[];
  checks: VerificationCheck[];
  reasons: string[];
}

/**
 * Max tolerated gap between the authority's co-signature time and the asserted
 * seal time. Binding the two stops a seal from claiming a time far from when
 * the root was actually co-signed. (It becomes adversarially load-bearing once
 * the authority runs in a trust domain separate from the operator.)
 */
const MAX_TSA_SKEW_MS = 5 * 60_000;

/**
 * Verify an Ed25519 timestamp-authority signature over a seal statement, using
 * the INDEPENDENTLY-PINNED authority keys — never the public key carried in the
 * bundle. That is the whole point: an operator can rebuild a self-consistent
 * forgery and re-sign it, but not with a key the verifier already trusts. No
 * network, no ASN.1, no AWS.
 */
export function verifyTsaAnchor(
  anchor: TsaAnchor,
  statement: SealStatement,
  pinnedKeys: string[] = pinnedTsaPublicKeys(),
): boolean {
  if (anchor.algorithm !== "ed25519") return false;
  const msg = Buffer.from(tsaSignedMessage(statement, anchor.signedAt), "utf8");
  const sig = Buffer.from(anchor.signature, "base64");
  for (const keyB64 of pinnedKeys) {
    try {
      const pub = createPublicKey({ key: Buffer.from(keyB64, "base64"), format: "der", type: "spki" });
      if (edVerify(null, msg, pub, sig)) return true;
    } catch {
      /* not this key — try the next pinned key */
    }
  }
  return false;
}

/** Verify a proof bundle offline. The heart of Muhuri's non-repudiation. */
export function verifyProofBundle(
  bundle: ProofBundle,
  opts: { pinnedKeys?: string[] } = {},
): VerificationResult {
  const pinnedKeys = opts.pinnedKeys ?? pinnedTsaPublicKeys();
  const { witness } = bundle;
  const statement = witness.statement;
  const witnessedRoot = statement.merkleRoot;
  const reasons: string[] = [];

  // Order bids by sequence; the verifier trusts nothing about how they arrived.
  const bids = [...bundle.bids].sort((a, b) => a.seq - b.seq);

  // 1. Reveal integrity — each opened commit must re-hash correctly.
  const badReveals: BadReveal[] = [];
  for (const bid of bids) {
    if (bid.amount === undefined || bid.nonce === undefined) continue; // unrevealed
    const recomputed = computeCommit(bid.amount, bid.nonce, bid.bidderId);
    if (recomputed !== bid.commit) {
      badReveals.push({
        seq: bid.seq,
        bidId: bid.bidId,
        reason: "revealed value does not hash to the sealed commit",
      });
    }
  }
  if (badReveals.length > 0) {
    reasons.push(`${badReveals.length} reveal(s) do not open their commitment`);
  }

  // 2. Ordering integrity — sequences must be 0..n-1, contiguous and unique.
  let orderingOk = true;
  for (let i = 0; i < bids.length; i++) {
    if (bids[i].seq !== i) {
      orderingOk = false;
      break;
    }
  }
  if (!orderingOk) reasons.push("bid sequence numbers are not contiguous from 0");

  // 3. Root match — rebuild over the ordered commits and compare to the witness.
  const commits = bids.map((b) => b.commit);
  const recomputedRoot = merkleRoot(commits);
  const rootMatches = recomputedRoot === witnessedRoot;
  if (!rootMatches) {
    reasons.push("recomputed Merkle root does not match the witnessed root");
  }

  // Chain head is a second, independent fingerprint of order.
  const recomputedFinalChainHead = finalChainHead(bundle.auctionId, commits);
  const chainMatches = recomputedFinalChainHead === statement.finalChainHead;
  if (!chainMatches) {
    reasons.push("recomputed final chain head does not match the witnessed head");
  }

  // Count must match the witnessed count.
  const countMatches = bids.length === statement.count;
  if (!countMatches) {
    reasons.push(
      `bid count ${bids.length} does not match witnessed count ${statement.count}`,
    );
  }

  // 4. Witness authenticity — the co-signature must verify against a PINNED
  // authority key, so a re-signed forgery (operator's own key) is rejected.
  const tsaValid = verifyTsaAnchor(witness.tsa, statement, pinnedKeys);
  if (!tsaValid) {
    reasons.push("the seal is not signed by the published timestamp authority");
  }

  // 5. Temporal binding — the co-signature time must track the asserted seal
  // time, so the recorded time cannot drift from when the root was signed.
  const signedAtMs = Date.parse(witness.tsa.signedAt);
  const sealedAtMs = Date.parse(statement.sealedAt);
  const tsaTimeConsistent =
    Number.isFinite(signedAtMs) &&
    Number.isFinite(sealedAtMs) &&
    Math.abs(signedAtMs - sealedAtMs) <= MAX_TSA_SKEW_MS;
  if (!tsaTimeConsistent) {
    reasons.push("co-signature time is inconsistent with the asserted seal time");
  }

  const valid =
    rootMatches &&
    chainMatches &&
    countMatches &&
    orderingOk &&
    tsaValid &&
    tsaTimeConsistent &&
    badReveals.length === 0;

  const checks: VerificationCheck[] = [
    {
      label: "Reveals open their commitments",
      ok: badReveals.length === 0,
      detail:
        badReveals.length === 0
          ? "every revealed amount hashes to its sealed commit"
          : `${badReveals.length} bad reveal(s)`,
    },
    {
      label: "Ordering is intact",
      ok: orderingOk,
      detail: orderingOk ? "sequences contiguous from 0" : "sequence gap or duplicate",
    },
    {
      label: "Merkle root matches the witness",
      ok: rootMatches,
      detail: rootMatches ? `root ${short(witnessedRoot)}` : "root mismatch",
    },
    {
      label: "Chain head matches the witness",
      ok: chainMatches,
      detail: chainMatches ? `head ${short(statement.finalChainHead)}` : "chain mismatch",
    },
    {
      label: "Bid count matches the witness",
      ok: countMatches,
      detail: `${bids.length} of ${statement.count}`,
    },
    {
      label: "Co-signature time matches the seal time",
      ok: tsaTimeConsistent,
      detail: tsaTimeConsistent ? "within tolerance of the seal time" : "time skew exceeds tolerance",
    },
    {
      label: "Authority signature verifies against the published key",
      ok: tsaValid,
      detail: tsaValid ? witness.tsa.authority : "not signed by the published authority",
    },
  ];

  return {
    valid,
    auctionId: bundle.auctionId,
    recomputedRoot,
    witnessedRoot,
    rootMatches,
    recomputedFinalChainHead,
    witnessedFinalChainHead: statement.finalChainHead,
    chainMatches,
    tsaValid,
    tsaTimeConsistent,
    tsaAuthority: witness.tsa.authority,
    countMatches,
    orderingOk,
    badReveals,
    checks,
    reasons,
  };
}

function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
