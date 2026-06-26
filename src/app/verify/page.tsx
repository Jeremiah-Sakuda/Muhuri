"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { verifyProofBundleBrowser } from "@/lib/verifier.browser";
import type { ProofBundle, VerificationResult } from "@/lib/verifier";

export default function VerifyPage() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("session") ?? params.get("auction");
    if (id) void loadAuction(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAuction(id: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const bundle = await api.getProof(id);
      setText(JSON.stringify(bundle, null, 2));
      setResult(await verifyProofBundleBrowser(bundle));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load session");
    } finally {
      setLoading(false);
    }
  }

  async function verifyText() {
    setError(null);
    setResult(null);
    let bundle: ProofBundle;
    try {
      bundle = JSON.parse(text);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    setLoading(true);
    try {
      setResult(await verifyProofBundleBrowser(bundle));
    } catch (e) {
      setError(e instanceof Error ? e.message : "verification failed");
    } finally {
      setLoading(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) void f.text().then(setText);
  }

  return (
    <div className="max-w-5xl mx-auto px-5 py-7">
      <header className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-2xl" aria-hidden>
              🔍
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Muhuri — public verifier</h1>
          </div>
          <p className="text-sm text-muted mt-2 max-w-2xl">
            Recompute a sealed agent session&apos;s fingerprint from its revealed actions and check it
            against the externally-witnessed root — <span className="text-ink">entirely in your browser,
            no server, no network</span>. The signature is checked against the published authority key
            the verifier holds independently. The same logic runs in the standalone CLI with zero AWS
            credentials.
          </p>
        </div>
        <Link href="/" className="text-sm text-muted hover:text-ink underline shrink-0">
          ← back
        </Link>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <h3 className="text-sm font-semibold mb-3">Proof bundle</h3>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Paste a proof bundle, upload one, or open this page with ?session=<id>'
            spellCheck={false}
            className="w-full h-64 bg-panel2 border border-edge2 rounded-lg p-3 text-[11px] mono outline-none focus:border-teal/60 scroll-thin resize-none"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={verifyText}
              disabled={loading || !text.trim()}
              className="rounded-lg border border-teal/50 bg-teal/15 text-teal text-sm px-3.5 py-2 font-medium disabled:opacity-40"
            >
              {loading ? "Verifying…" : "Verify"}
            </button>
            <label className="text-xs text-muted hover:text-ink cursor-pointer underline">
              upload .json
              <input type="file" accept="application/json,.json" onChange={onFile} className="hidden" />
            </label>
          </div>
          {error && <p className="text-xs text-danger mt-3">{error}</p>}
        </div>

        <div className="card p-5">
          <h3 className="text-sm font-semibold mb-3">Result</h3>
          {!result && <p className="text-sm text-faint">No verification run yet.</p>}
          {result && <ResultView result={result} />}
        </div>
      </div>
    </div>
  );
}

function ResultView({ result }: { result: VerificationResult }) {
  return (
    <div className="space-y-4">
      <div
        className={`rounded-lg border p-3 ${
          result.valid ? "border-teal/40 bg-teal/5" : "border-danger/40 bg-danger/5"
        }`}
      >
        <div className={`text-base font-semibold ${result.valid ? "text-teal" : "text-danger"}`}>
          {result.valid ? "✓ VALID" : "✗ INVALID"}
        </div>
        <div className="text-xs text-muted mt-0.5">
          {result.valid
            ? "Order and contents match the externally-witnessed root."
            : "The presented data does not match the witness."}
        </div>
      </div>

      {/* operator-claims vs witness diff */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-faint mb-1">
          recomputed root (from revealed bids)
        </div>
        <div className={`mono text-[11px] break-all ${result.rootMatches ? "text-teal" : "text-danger"}`}>
          {result.recomputedRoot}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-faint mt-2 mb-1">
          witnessed root (S3 Object Lock)
        </div>
        <div className="mono text-[11px] break-all text-cyan">{result.witnessedRoot}</div>
        <div className={`text-xs mt-1 ${result.rootMatches ? "text-teal" : "text-danger"}`}>
          {result.rootMatches ? "→ identical" : "→ MISMATCH — the set was altered, reordered, or backdated"}
        </div>
      </div>

      <div className="border-t border-edge pt-3 space-y-1.5">
        {result.checks.map((c) => (
          <div key={c.label} className="flex items-start gap-2 text-xs">
            <span className={c.ok ? "text-teal" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
            <span className="text-ink flex-1">{c.label}</span>
            <span className="text-faint text-[10px]">{c.detail}</span>
          </div>
        ))}
      </div>

      {!result.valid && result.reasons.length > 0 && (
        <div className="border-t border-edge pt-3">
          <div className="text-[10px] uppercase tracking-wider text-faint mb-1">why it failed</div>
          {result.reasons.map((r, i) => (
            <div key={i} className="text-xs text-danger">
              • {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
