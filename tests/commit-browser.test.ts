import { describe, it, expect } from "vitest";
import { computeCommit } from "@/lib/crypto";
import { browserComputeCommit } from "@/lib/commit-browser";

describe("browser commit is byte-identical to server commit", () => {
  it("agrees across ASCII, empty, and multibyte UTF-8 inputs", async () => {
    const cases: [string, string, string][] = [
      ["1000", "abcd", "acme"],
      ["0", "", "x"],
      ["999999", "deadbeef", "Globex Networks ™ 你好"],
      ["2480000.50", "f0f0f0f0", "Acme Infrastructure, LLC"],
    ];
    for (const [amount, nonce, bidderId] of cases) {
      expect(await browserComputeCommit(amount, nonce, bidderId)).toBe(
        computeCommit(amount, nonce, bidderId),
      );
    }
  });
});
