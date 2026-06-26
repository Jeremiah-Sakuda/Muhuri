/**
 * Browser-side proof verifier — runs entirely on the client.
 *
 * Same logic and same VerificationResult shape as the node verifier, but built
 * on Web Crypto (SHA-256) + @noble/ed25519 (signature), so it executes with no
 * server round-trip. That is what makes "Wi-Fi off, Network tab empty, still
 * INVALID" literally true. It checks the signature against the INDEPENDENTLY
 * pinned authority keys, so a re-signed forgery is rejected.
 */
import { verifyAsync } from "@noble/ed25519";
import {
  browserComputeCommit,
  browserFinalChainHead,
  browserMerkleRoot,
  browserTsaSignedMessage,
} from "./crypto-browser";
import { b64ToBytes, pinnedTsaPublicKeys, rawEd25519FromSpkiB64 } from "./tsa-pinned";
import type { SealStatement, TsaAnchor } from "./types";
import type {
  BadReveal,
  ProofBundle,
  VerificationCheck,
  VerificationResult,
} from "./verifier";

const MAX_TSA_SKEW_MS = 5 * 60_000;
const enc = new TextEncoder();

function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

async function verifyTsaBrowser(
  anchor: TsaAnchor,
  statement: SealStatement,
  pinnedKeys: string[],
): Promise<boolean> {
  if (anchor.algorithm !== "ed25519") return false;
  const msg = enc.encode(browserTsaSignedMessage(statement, anchor.signedAt));
  let sig: Uint8Array;
  try {
    sig = b64ToBytes(anchor.signature);
  } catch {
    return false;
  }
  for (const keyB64 of pinnedKeys) {
    try {
      const rawPub = rawEd25519FromSpkiB64(keyB64);
      if (await verifyAsync(sig, msg, rawPub)) return true;
    } catch {
      /* not this key — try the next pinned key */
    }
  }
  return false;
}

export async function verifyProofBundleBrowser(
  bundle: ProofBundle,
  opts: { pinnedKeys?: string[] } = {},
): Promise<VerificationResult> {
  const pinnedKeys = opts.pinnedKeys ?? pinnedTsaPublicKeys();
  const { witness } = bundle;
  const statement = witness.statement;
  const witnessedRoot = statement.merkleRoot;
  const reasons: string[] = [];

  const bids = [...bundle.bids].sort((a, b) => a.seq - b.seq);

  const badReveals: BadReveal[] = [];
  for (const bid of bids) {
    if (bid.amount === undefined || bid.nonce === undefined) continue;
    const recomputed = await browserComputeCommit(bid.amount, bid.nonce, bid.bidderId);
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

  let orderingOk = true;
  for (let i = 0; i < bids.length; i++) {
    if (bids[i].seq !== i) {
      orderingOk = false;
      break;
    }
  }
  if (!orderingOk) reasons.push("bid sequence numbers are not contiguous from 0");

  const commits = bids.map((b) => b.commit);
  const recomputedRoot = await browserMerkleRoot(commits);
  const rootMatches = recomputedRoot === witnessedRoot;
  if (!rootMatches) reasons.push("recomputed Merkle root does not match the witnessed root");

  const recomputedFinalChainHead = await browserFinalChainHead(bundle.auctionId, commits);
  const chainMatches = recomputedFinalChainHead === statement.finalChainHead;
  if (!chainMatches) {
    reasons.push("recomputed final chain head does not match the witnessed head");
  }

  const countMatches = bids.length === statement.count;
  if (!countMatches) {
    reasons.push(`bid count ${bids.length} does not match witnessed count ${statement.count}`);
  }

  const signedAtMs = Date.parse(witness.tsa.signedAt);
  const sealedAtMs = Date.parse(statement.sealedAt);
  const tsaTimeConsistent =
    Number.isFinite(signedAtMs) &&
    Number.isFinite(sealedAtMs) &&
    Math.abs(signedAtMs - sealedAtMs) <= MAX_TSA_SKEW_MS;
  if (!tsaTimeConsistent) {
    reasons.push("co-signature time is inconsistent with the asserted seal time");
  }

  const tsaValid = await verifyTsaBrowser(witness.tsa, statement, pinnedKeys);
  if (!tsaValid) {
    reasons.push("the seal is not signed by the published timestamp authority");
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
