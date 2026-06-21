"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, type AuctionView } from "@/lib/api/client";
import { browserComputeCommit, browserRandomNonce } from "@/lib/commit-browser";
import type { AuditEvent, WitnessBundle } from "@/lib/types";
import type { VerificationResult } from "@/lib/verifier";
import { Button, Hash, Pill, SectionTitle, Stat } from "@/components/ui";

type Secret = { bidId: string; bidderId: string; amount: string; nonce: string };
type AttackEntry = { id: number; tone: "danger" | "teal"; title: string; detail: string };

const SESSION_KEY = "muhuri.session.v1";
const COMPANIES = [
  "Acme Infrastructure",
  "Globex Networks",
  "Initech Civil",
  "Umbrella Telecom",
  "Soylent Works",
  "Hooli Build",
];

function uuid(): string {
  return crypto.randomUUID();
}

export default function AuctionRoom() {
  const [auctionId, setAuctionId] = useState<string | null>(null);
  const [sealToken, setSealToken] = useState<string | null>(null);
  const [view, setView] = useState<AuctionView | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [witness, setWitness] = useState<WitnessBundle | null>(null);
  const [secrets, setSecrets] = useState<Record<string, Secret>>({});
  const [attacks, setAttacks] = useState<AttackEntry[]>([]);
  const [verifyResult, setVerifyResult] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [bidder, setBidder] = useState(COMPANIES[0]);
  const attackId = useRef(0);

  const sealed = view?.meta.status === "CLOSED";

  // --- persistence ---------------------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        setAuctionId(s.auctionId ?? null);
        setSealToken(s.sealToken ?? null);
        setSecrets(s.secrets ?? {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (auctionId) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ auctionId, sealToken, secrets }));
    }
  }, [auctionId, sealToken, secrets]);

  // --- polling -------------------------------------------------------------
  const refresh = useCallback(async (id: string) => {
    try {
      const [v, e] = await Promise.all([api.getAuction(id), api.getEvents(id)]);
      setView(v);
      setEvents(e.events);
      if (v.close?.witness) setWitness(v.close.witness);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    if (!auctionId) return;
    refresh(auctionId);
    const t = setInterval(() => refresh(auctionId), 1300);
    return () => clearInterval(t);
  }, [auctionId, refresh]);

  // --- actions -------------------------------------------------------------
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    localStorage.removeItem(SESSION_KEY);
    setAuctionId(null);
    setSealToken(null);
    setView(null);
    setEvents([]);
    setWitness(null);
    setSecrets({});
    setAttacks([]);
    setVerifyResult(null);
  }

  async function startDemo() {
    await run("demo", async () => {
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      const seed = await api.seedDemo({ deadline });
      const map: Record<string, Secret> = {};
      for (const r of seed.reveals) map[r.bidId] = r;
      setSecrets(map);
      setSealToken(seed.sealToken);
      setAuctionId(seed.auctionId);
      setAttacks([]);
      setVerifyResult(null);
      setWitness(null);
    });
  }

  async function placeBid() {
    if (!auctionId || !amount.trim()) return;
    await run("bid", async () => {
      const bidId = uuid();
      const nonce = browserRandomNonce();
      const commit = await browserComputeCommit(amount.trim(), nonce, bidder);
      await api.appendBid(auctionId, { bidId, commit, bidderId: bidder });
      setSecrets((s) => ({ ...s, [bidId]: { bidId, bidderId: bidder, amount: amount.trim(), nonce } }));
      setAmount("");
      setBidder(COMPANIES[Math.floor(Math.random() * COMPANIES.length)]);
      await refresh(auctionId);
    });
  }

  async function seal() {
    if (!auctionId || !sealToken) return;
    await run("seal", async () => {
      const close = await api.seal(auctionId, sealToken);
      if (close.witness) setWitness(close.witness);
      await refresh(auctionId);
    });
  }

  async function revealAll() {
    if (!auctionId || !view) return;
    await run("reveal", async () => {
      for (const bid of view.bids) {
        if (bid.revealed) continue;
        const s = secrets[bid.bidId];
        if (s) await api.reveal(auctionId, { bidId: bid.bidId, amount: s.amount, nonce: s.nonce });
      }
      await refresh(auctionId);
    });
  }

  function logAttack(tone: "danger" | "teal", title: string, detail: string) {
    setAttacks((a) => [{ id: ++attackId.current, tone, title, detail }, ...a].slice(0, 6));
  }

  async function attackLateBid() {
    if (!auctionId) return;
    await run("late", async () => {
      try {
        await api.appendBid(auctionId, {
          bidId: uuid(),
          bidderId: "Backroom Bidder",
          commit: "f".repeat(64),
        });
        logAttack("danger", "Late bid slipped in?!", "The append unexpectedly succeeded.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          logAttack(
            "teal",
            "Late bid REJECTED",
            `DynamoDB ConditionExpression (status = OPEN) failed — the auction is CLOSED. Wrong position in time, refused by the database itself (${err.reason}).`,
          );
        } else throw err;
      }
      await refresh(auctionId);
    });
  }

  async function attackOverwrite() {
    if (!auctionId) return;
    await run("overwrite", async () => {
      try {
        await api.attackOverwrite(auctionId);
        logAttack("danger", "Witness overwritten?!", "The witness unexpectedly accepted a rewrite.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          logAttack(
            "teal",
            "Witness overwrite REFUSED",
            "S3 Object Lock (COMPLIANCE) refuses to overwrite or delete the sealed proof — not even the account root can. The external copy is immutable.",
          );
        } else throw err;
      }
    });
  }

  async function attackTamper() {
    if (!auctionId) return;
    await run("tamper", async () => {
      const bundle = await api.getProof(auctionId);
      if (!bundle.bids.length) return;
      // The operator rewrites a sealed bid AND recomputes its commit so the
      // record stays internally consistent — but the Merkle root now diverges
      // from the externally-witnessed one, and the verifier catches that.
      const target = bundle.bids[0];
      const nonce = target.nonce ?? "0";
      const newCommit = await browserComputeCommit("1", nonce, target.bidderId);
      const forged = structuredClone(bundle);
      forged.bids[0] = { ...target, amount: "1", nonce, commit: newCommit };
      const result = await api.verify(forged);
      setVerifyResult(result);
      logAttack(
        result.valid ? "danger" : "teal",
        "Tampered bid CAUGHT",
        result.valid
          ? "Verifier unexpectedly accepted the forgery."
          : "The operator edited a sealed bid; the recomputed Merkle root no longer matches the externally-witnessed root.",
      );
    });
  }

  async function runVerifier() {
    if (!auctionId) return;
    await run("verify", async () => {
      const bundle = await api.getProof(auctionId);
      setVerifyResult(await api.verify(bundle));
    });
  }

  function downloadProof() {
    if (!auctionId) return;
    window.open(`/api/auctions/${auctionId}/proof`, "_blank");
  }

  // --- empty state ---------------------------------------------------------
  if (!auctionId || !view) {
    return (
      <div className="card p-10 text-center max-w-2xl mx-auto mt-10">
        <div className="text-5xl mb-4">🪔</div>
        <h2 className="text-xl font-semibold mb-2">Notarize a sealed-bid auction</h2>
        <p className="text-muted text-sm mb-6 max-w-md mx-auto">
          Bids are hash-committed and chained as they arrive. At the deadline, one atomic database
          transaction seals the set and an external witness anchors the proof — verifiable by anyone.
        </p>
        <div className="flex gap-3 justify-center">
          <Button tone="primary" onClick={startDemo} disabled={busy === "demo"}>
            {busy === "demo" ? "Seeding…" : "Start a demo auction"}
          </Button>
          <Link href="/verify" className="text-sm text-muted hover:text-ink self-center underline">
            or open the public verifier →
          </Link>
        </div>
      </div>
    );
  }

  // --- main ----------------------------------------------------------------
  const revealedCount = view.bids.filter((b) => b.revealed).length;
  return (
    <div className="space-y-5">
      {/* status header */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-[260px]">
            <div className="flex items-center gap-2 mb-1">
              {sealed ? <Pill tone="sealed">● SEALED</Pill> : <span className="inline-flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-teal pulse-dot inline-block" /><Pill tone="open">OPEN</Pill></span>}
              {view.meta.deadline && (
                <span className="text-xs text-faint">
                  deadline {new Date(view.meta.deadline).toLocaleTimeString()}
                </span>
              )}
            </div>
            <h2 className="text-lg font-semibold text-ink">{view.meta.title}</h2>
            <div className="text-xs text-faint mt-1">
              auction <span className="mono">{view.meta.auctionId.slice(0, 8)}</span> · {view.meta.count} bids
            </div>
          </div>
          <div className="min-w-[260px]">
            <div className="text-[10px] uppercase tracking-wider text-faint mb-1">
              public chain head {!sealed && <span className="text-teal">· live</span>}
            </div>
            <div className="mono text-sm text-cyan break-all">{view.chainHead}</div>
            {!sealed && <div className="h-[2px] mt-1.5 rounded live-underline opacity-70" />}
          </div>
          <Button tone="ghost" size="sm" onClick={reset}>
            reset
          </Button>
        </div>
      </div>

      {/* three-column workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* LEFT — chain + bid form */}
        <div className="card p-5">
          <SectionTitle title="Commitment chain" role="Bidder" hint={`${view.bids.length} links`} />
          <div className="space-y-2 max-h-[320px] overflow-auto scroll-thin pr-1">
            {view.bids.length === 0 && <p className="text-sm text-faint">No bids yet.</p>}
            {view.bids.map((b) => (
              <div key={b.bidId} className="slide-in rounded-lg border border-edge bg-panel2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-[11px] text-faint">
                    #{String(b.seq).padStart(3, "0")}
                  </span>
                  <span className="text-xs text-ink truncate flex-1">{b.bidderId}</span>
                  {b.revealed ? (
                    <span className="text-xs text-teal font-medium">
                      ${Number(b.amount).toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-[10px] text-faint italic">sealed</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-faint">commit</span>
                  <Hash value={b.commit} chars={6} />
                </div>
              </div>
            ))}
          </div>
          {!sealed && (
            <div className="mt-4 border-t border-edge pt-4">
              <div className="flex gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="bid amount"
                  inputMode="numeric"
                  className="flex-1 bg-panel2 border border-edge2 rounded-lg px-3 py-2 text-sm outline-none focus:border-teal/60 mono"
                />
                <Button tone="primary" size="sm" onClick={placeBid} disabled={busy === "bid" || !amount}>
                  Commit
                </Button>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={bidder}
                  onChange={(e) => setBidder(e.target.value)}
                  className="bg-panel2 border border-edge2 rounded-lg px-2 py-1.5 text-xs text-muted outline-none"
                >
                  {COMPANIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-faint">
                  amount hashed in your browser — hidden until reveal
                </span>
              </div>
            </div>
          )}
        </div>

        {/* MIDDLE — seal + witness */}
        <div className="card p-5">
          <SectionTitle title="The seal" role="Organizer" hint={sealed ? "closed" : "open"} />
          {!sealed ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted mb-5">
                One atomic <span className="mono text-cyan">TransactWriteItems</span> flips the auction
                to <span className="text-gold">CLOSED</span> and freezes the Merkle root over the
                ordered commits — then anchors it to the external witness.
              </p>
              <Button tone="gold" onClick={seal} disabled={busy === "seal" || view.bids.length === 0}>
                {busy === "seal" ? "Sealing…" : "🪔 Seal the auction"}
              </Button>
              {view.bids.length === 0 && (
                <p className="text-[11px] text-faint mt-2">add at least one bid first</p>
              )}
            </div>
          ) : witness ? (
            <WitnessView witness={witness} deadline={view.meta.deadline} onDownload={downloadProof} onReveal={revealAll} revealing={busy === "reveal"} revealed={revealedCount} total={view.bids.length} />
          ) : (
            <p className="text-sm text-faint py-6 text-center">anchoring witness…</p>
          )}
        </div>

        {/* RIGHT — attacks + verifier */}
        <div className="space-y-5">
          <div className="card p-5">
            <SectionTitle title="Attacks" role="Auditor" hint="prove it holds" />
            <div className="grid grid-cols-1 gap-2">
              <Button tone="danger" size="sm" onClick={attackLateBid} disabled={!sealed || busy === "late"}>
                ① Slip in a late bid
              </Button>
              <Button tone="danger" size="sm" onClick={attackTamper} disabled={!sealed || busy === "tamper"}>
                ② Tamper with a sealed bid
              </Button>
              <Button tone="danger" size="sm" onClick={attackOverwrite} disabled={!sealed || busy === "overwrite"}>
                ③ Overwrite the witness
              </Button>
              {!sealed && <p className="text-[11px] text-faint">seal the auction to run attacks</p>}
            </div>
            <div className="mt-3 space-y-2">
              {attacks.map((a) => (
                <div
                  key={a.id}
                  className={`rounded-lg border px-3 py-2 ${
                    a.tone === "teal" ? "border-teal/40 bg-teal/5" : "border-danger/40 bg-danger/5"
                  }`}
                >
                  <div className={`text-xs font-semibold ${a.tone === "teal" ? "text-teal" : "text-danger"}`}>
                    {a.tone === "teal" ? "✓ " : "✗ "}
                    {a.title}
                  </div>
                  <div className="text-[11px] text-muted mt-0.5">{a.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <VerifierCard
            sealed={sealed}
            result={verifyResult}
            onRun={runVerifier}
            running={busy === "verify"}
            auctionId={auctionId}
          />
        </div>
      </div>

      {/* DynamoDB ledger */}
      <LedgerPanel events={events} auctionId={view.meta.auctionId} />
    </div>
  );
}

function WitnessView({
  witness,
  deadline,
  onDownload,
  onReveal,
  revealing,
  revealed,
  total,
}: {
  witness: WitnessBundle;
  deadline?: string;
  onDownload: () => void;
  onReveal: () => void;
  revealing: boolean;
  revealed: number;
  total: number;
}) {
  const s = witness.statement;
  const beforeDeadline = deadline ? Date.parse(s.sealedAt) <= Date.parse(deadline) : null;
  return (
    <div className="stamp-in space-y-3">
      <div className="rounded-lg border border-gold/30 bg-gold/5 p-3">
        <div className="text-[10px] uppercase tracking-wider text-faint mb-1">Merkle root (witnessed)</div>
        <div className="mono text-xs text-gold break-all">{s.merkleRoot}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="sealed at">
          <span className="mono text-xs">{new Date(s.sealedAt).toLocaleString()}</span>
        </Stat>
        <Stat label="bids sealed">{s.count}</Stat>
      </div>
      {beforeDeadline !== null && (
        <div className={`text-xs ${beforeDeadline ? "text-teal" : "text-danger"}`}>
          {beforeDeadline ? "✓ sealed before the deadline" : "✗ sealed after the deadline"}{" "}
          <span className="text-faint">(witnessed time, not the operator&apos;s clock)</span>
        </div>
      )}

      <div className="border-t border-edge pt-3 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-faint">Witness quorum</div>
        <div className="flex items-center gap-2">
          <Pill tone="teal">S3 Object Lock</Pill>
          <span className="text-xs text-ink">COMPLIANCE</span>
          <span className="text-[10px] text-faint ml-auto mono">{witness.worm.key}</span>
        </div>
        <div className="text-[10px] text-faint">
          immutable until {new Date(witness.worm.retainUntil).toLocaleDateString()} · not even root can delete
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Pill tone="teal">Timestamp authority</Pill>
          <span className="text-xs text-ink">Ed25519</span>
          <Hash value={witness.tsa.publicKey} chars={6} className="ml-auto" />
        </div>
        <div className="text-[10px] text-faint">
          independent signer · {witness.tsa.authority} · verifiable offline
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button tone="primary" size="sm" onClick={onReveal} disabled={revealing || revealed === total}>
          {revealed === total ? `Revealed ${revealed}/${total}` : revealing ? "Revealing…" : `Reveal bids (${revealed}/${total})`}
        </Button>
        <Button size="sm" onClick={onDownload}>
          ⤓ Proof bundle
        </Button>
      </div>
    </div>
  );
}

function VerifierCard({
  sealed,
  result,
  onRun,
  running,
  auctionId,
}: {
  sealed: boolean;
  result: VerificationResult | null;
  onRun: () => void;
  running: boolean;
  auctionId: string;
}) {
  return (
    <div className="card p-5">
      <SectionTitle title="Offline verifier" role="Auditor" hint="zero AWS creds" />
      <p className="text-xs text-muted mb-3">
        Rebuilds the Merkle root from revealed bids and checks it against the externally-witnessed
        root — the same code a losing bidder or a court would run.
      </p>
      <div className="flex gap-2 mb-3">
        <Button tone="primary" size="sm" onClick={onRun} disabled={!sealed || running}>
          {running ? "Verifying…" : "Run verifier"}
        </Button>
        <Link
          href={`/verify?auction=${auctionId}`}
          className="text-xs text-muted hover:text-ink self-center underline"
        >
          public page →
        </Link>
      </div>
      {result && (
        <div
          className={`rounded-lg border p-3 ${
            result.valid ? "border-teal/40 bg-teal/5" : "border-danger/40 bg-danger/5"
          }`}
        >
          <div className={`text-sm font-semibold mb-2 ${result.valid ? "text-teal" : "text-danger"}`}>
            {result.valid ? "✓ VALID — proof holds" : "✗ INVALID — proof broken"}
          </div>
          <div className="space-y-1">
            {result.checks.map((c) => (
              <div key={c.label} className="flex items-start gap-2 text-[11px]">
                <span className={c.ok ? "text-teal" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span className="text-muted flex-1">{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LedgerPanel({ events, auctionId }: { events: AuditEvent[]; auctionId: string }) {
  const pk = `AUCTION#${auctionId.slice(0, 8)}…`;
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">DynamoDB write log</h3>
        <Pill tone="neutral">via Streams</Pill>
        <span className="text-xs text-faint ml-auto mono">{pk}</span>
      </div>
      <div className="space-y-1.5 max-h-[230px] overflow-auto scroll-thin font-mono text-[11px]">
        {events.length === 0 && <p className="text-faint">no writes yet</p>}
        {events.map((e) => (
          <LedgerRow key={`${e.type}-${e.seq}`} event={e} />
        ))}
      </div>
    </div>
  );
}

function LedgerRow({ event }: { event: AuditEvent }) {
  if (event.type === "SEALED") {
    return (
      <div className="slide-in rounded border border-gold/30 bg-gold/5 px-2.5 py-1.5">
        <div className="text-gold">
          TransactWriteItems · 2 items <span className="text-faint">(atomic, ClientRequestToken)</span>
        </div>
        <div className="text-muted pl-3">↳ Update SK=META · SET status=CLOSED · IF status=OPEN</div>
        <div className="text-muted pl-3">↳ Put SK=CLOSE · merkleRoot · IF attribute_not_exists(SK)</div>
      </div>
    );
  }
  const labels: Record<string, { sk: string; color: string; op: string }> = {
    AUCTION_CREATED: { sk: "META", color: "text-cyan", op: "PutItem · status=OPEN" },
    BID_COMMITTED: {
      sk: `BID#${String(event.detail.seq).padStart(3, "0")}`,
      color: "text-ink",
      op: "PutItem · IF status=OPEN",
    },
    BID_REVEALED: {
      sk: `BID#${String(event.detail.seq).padStart(3, "0")}`,
      color: "text-muted",
      op: "UpdateItem · SET revealed=true",
    },
  };
  const l = labels[event.type] ?? { sk: event.type, color: "text-muted", op: "" };
  return (
    <div className="slide-in flex items-center gap-2 px-2.5 py-1">
      <span className="text-faint w-7">{String(event.seq).padStart(2, "0")}</span>
      <span className={`${l.color} w-24`}>SK={l.sk}</span>
      <span className="text-faint flex-1 truncate">{l.op}</span>
    </div>
  );
}
