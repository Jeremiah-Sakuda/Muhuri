import { describe, it, expect } from "vitest";
import {
  computeCommit,
  canonicalConcat,
  chainHeadZero,
  nextChainHead,
  finalChainHead,
  merkleRoot,
  merkleProof,
  rootFromProof,
} from "@/lib/crypto";

describe("commitment", () => {
  it("is deterministic and hides the amount until reveal", () => {
    expect(computeCommit("1000", "abcd", "acme")).toBe(
      computeCommit("1000", "abcd", "acme"),
    );
  });

  it("changes if the revealed amount differs (no equivocation)", () => {
    expect(computeCommit("1000", "abcd", "acme")).not.toBe(
      computeCommit("1001", "abcd", "acme"),
    );
  });

  it("canonical encoding is injective across field boundaries", () => {
    // ("12","3") must not collide with ("1","23").
    expect(canonicalConcat("d", ["12", "3"])).not.toBe(canonicalConcat("d", ["1", "23"]));
  });
});

describe("hash chain (fixes order)", () => {
  it("is sensitive to reordering", () => {
    const id = "auction-1";
    const a = computeCommit("1", "n1", "a");
    const b = computeCommit("2", "n2", "b");
    expect(finalChainHead(id, [a, b])).not.toBe(finalChainHead(id, [b, a]));
  });

  it("genesis depends on the auction id", () => {
    expect(chainHeadZero("x")).not.toBe(chainHeadZero("y"));
  });

  it("each step folds in the prior head, commit, and seq", () => {
    const id = "a";
    const c = computeCommit("1", "n", "a");
    const expected = nextChainHead(chainHeadZero(id), c, 0);
    expect(finalChainHead(id, [c])).toBe(expected);
  });
});

describe("merkle root (fixes the ordered set)", () => {
  const leaves = ["c0", "c1", "c2", "c3", "c4"].map((x) => computeCommit(x, "n", "b"));

  it("is order-sensitive", () => {
    const swapped = [leaves[1], leaves[0], ...leaves.slice(2)];
    expect(merkleRoot(leaves)).not.toBe(merkleRoot(swapped));
  });

  it("is content-sensitive", () => {
    const edited = [...leaves];
    edited[2] = computeCommit("tampered", "n", "b");
    expect(merkleRoot(leaves)).not.toBe(merkleRoot(edited));
  });

  it("produces verifiable inclusion proofs for every leaf (odd count)", () => {
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(rootFromProof(leaves[i], merkleProof(leaves, i))).toBe(root);
    }
  });

  it("a proof from the wrong leaf does not reconstruct the root", () => {
    const root = merkleRoot(leaves);
    expect(rootFromProof(leaves[1], merkleProof(leaves, 0))).not.toBe(root);
  });
});
