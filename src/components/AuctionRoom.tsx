"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError, type AuctionView } from "@/lib/api/client";
import { browserComputeCommit, browserRandomNonce } from "@/lib/commit-browser";
import { verifyProofBundleBrowser } from "@/lib/verifier.browser";
import { forgeWinningBid, operatorConsistencyCheck, type ForgeResult } from "@/lib/forge-browser";
import type { AuditEvent, WitnessBundle } from "@/lib/types";
import type { VerificationResult } from "@/lib/verifier";
import { Button, Hash, Pill, SectionTitle, Stat } from "@/components/ui";

type Secret = { bidId: string; bidderId: string; amount: string; nonce: string };
type AttackEntry = { id: number; tone: "danger" | "teal"; title: string; detail: string };
type ForgeState = {
  result: ForgeResult;
  operator: { allOk: boolean; checks: { label: string; ok: boolean }[] };
};

const SESSION_KEY = "muhuri.session.v1";
const ACTION_TYPES = [
  "read_file",
  "web_search",
  "db_query",
  "http_request",
  "send_email",
  "execute_payment",
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
  const [forge, setForge] = useState<ForgeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [bidder, setBidder] = useState(ACTION_TYPES[0]);
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
    setForge(null);
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
      setForge(null);
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
      setBidder(ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)]);
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
          bidderId: "delete_logs",
          commit: "f".repeat(64),
        });
        logAttack("danger", "Back-dated action slipped in?!", "The append unexpectedly succeeded.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          logAttack(
            "teal",
            "Back-dated action REJECTED",
            `DynamoDB ConditionExpression (status = OPEN) failed — the session is SEALED. Wrong position in time, refused by the database itself (${err.reason}).`,
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
        logAttack("danger", "Witnessed log overwritten?!", "The witness unexpectedly accepted a rewrite.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          logAttack(
            "teal",
            "Witnessed log overwrite REFUSED",
            "S3 Object Lock (COMPLIANCE) refuses to overwrite or delete the witnessed log — not even the account root can. The external copy is immutable.",
          );
        } else throw err;
      }
    });
  }

  async function attackForge() {
    if (!auctionId || !view) return;
    await run("forge", async () => {
      // The operator can only rewrite what's been revealed — so reveal first,
      // making "Seal → Forge" a single click instead of a silent no-op.
      if (!view.bids.some((b) => b.revealed)) {
        for (const bid of view.bids) {
          const s = secrets[bid.bidId];
          if (s) await api.reveal(auctionId, { bidId: bid.bidId, amount: s.amount, nonce: s.nonce });
        }
        await refresh(auctionId);
      }
      const bundle = await api.getProof(auctionId);
      if (!bundle.bids.some((b) => b.amount !== undefined)) {
        logAttack("danger", "Nothing to forge", "Reveal some actions first, then forge.");
        return;
      }
      // The perfect crime: rewrite a logged action and rebuild EVERYTHING the
      // operator controls — commit, Merkle root, chain head — then re-sign with
      // a fresh operator key. Internally flawless.
      const result = await forgeWinningBid(bundle);
      const operator = await operatorConsistencyCheck(result.forged);
      setForge({ result, operator });
      setVerifyResult(null);
      logAttack(
        "danger",
        "Operator forged a logged action",
        `${result.label}: "${result.originalDetail}" → "${result.newDetail}". Commit, Merkle root and chain rebuilt; re-signed with the operator's own key. Their console says "all consistent" — now run the offline verifier.`,
      );
    });
  }

  async function runVerifier() {
    if (!auctionId) return;
    await run("verify", async () => {
      // The forged bundle is already in memory (no network); the honest path
      // fetches the published bundle once. Either way the CHECK runs in-browser.
      const bundle = forge?.result.forged ?? (await api.getProof(auctionId));
      setVerifyResult(await verifyProofBundleBrowser(bundle));
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
        <h2 className="text-xl font-semibold mb-2">Record an autonomous agent&apos;s actions</h2>
        <p className="text-muted text-sm mb-6 max-w-md mx-auto">
          Each action an AI agent takes is hash-committed and chained as it happens. The session seals
          into a Merkle root an external witness co-signs — so a regulator can prove, offline, exactly
          what the agent did and in what order, without trusting the operator.
        </p>
        <div className="flex gap-3 justify-center">
          <Button tone="primary" onClick={startDemo} disabled={busy === "demo"}>
            {busy === "demo" ? "Seeding…" : "Start a demo session"}
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
              session <span className="mono">{view.meta.auctionId.slice(0, 8)}</span> · {view.meta.count} actions
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
          <SectionTitle title="Action log" role="Agent" hint={`${view.bids.length} actions`} />
          <div className="space-y-2 max-h-[320px] overflow-auto scroll-thin pr-1">
            {view.bids.length === 0 && <p className="text-sm text-faint">No actions yet.</p>}
            {view.bids.map((b) => (
              <div key={b.bidId} className="slide-in rounded-lg border border-edge bg-panel2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-[11px] text-faint">
                    #{String(b.seq).padStart(3, "0")}
                  </span>
                  <span className="mono text-xs text-cyan truncate flex-1">{b.bidderId}()</span>
                  {b.revealed ? (
                    <span className="text-[10px] text-teal">revealed</span>
                  ) : (
                    <span className="text-[10px] text-faint italic">sealed</span>
                  )}
                </div>
                {b.revealed && b.amount && (
                  <div className="text-[11px] text-ink mt-1 truncate" title={b.amount}>
                    {b.amount}
                  </div>
                )}
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
                <select
                  value={bidder}
                  onChange={(e) => setBidder(e.target.value)}
                  className="bg-panel2 border border-edge2 rounded-lg px-2 py-2 text-xs text-cyan mono outline-none"
                >
                  {ACTION_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="action detail"
                  className="flex-1 bg-panel2 border border-edge2 rounded-lg px-3 py-2 text-sm outline-none focus:border-teal/60 mono"
                />
                <Button tone="primary" size="sm" onClick={placeBid} disabled={busy === "bid" || !amount}>
                  Log
                </Button>
              </div>
              <div className="text-[10px] text-faint mt-2">
                detail hashed in your browser — committed but hidden until reveal
              </div>
            </div>
          )}
        </div>

        {/* MIDDLE — seal + witness */}
        <div className="card p-5">
          <SectionTitle title="The seal" role="Operator" hint={sealed ? "closed" : "open"} />
          {!sealed ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted mb-5">
                One atomic <span className="mono text-cyan">TransactWriteItems</span> flips the session
                to <span className="text-gold">SEALED</span> and freezes the Merkle root over the
                ordered actions — then anchors it to the external witness.
              </p>
              <Button tone="gold" onClick={seal} disabled={busy === "seal" || view.bids.length === 0}>
                {busy === "seal" ? "Sealing…" : "🪔 Seal the session"}
              </Button>
              {view.bids.length === 0 && (
                <p className="text-[11px] text-faint mt-2">log at least one action first</p>
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
                ① Inject a back-dated action
              </Button>
              <Button tone="danger" size="sm" onClick={attackForge} disabled={!sealed || busy === "forge"}>
                ② Forge a logged action
              </Button>
              <Button tone="danger" size="sm" onClick={attackOverwrite} disabled={!sealed || busy === "overwrite"}>
                ③ Overwrite the witnessed log
              </Button>
              {!sealed && <p className="text-[11px] text-faint">seal the session to run attacks</p>}
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
            forge={forge}
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
  const isS3 = witness.worm.kind === "s3-object-lock";
  const beforeDeadline = deadline ? Date.parse(s.sealedAt) <= Date.parse(deadline) : null;
  return (
    <div className="stamp-in space-y-3">
      <div className="rounded-lg border border-gold/30 bg-gold/5 p-3">
        <div className="text-[10px] uppercase tracking-wider text-faint mb-1">Merkle root (witnessed)</div>
        <div className="mono text-xs text-gold break-all">{s.merkleRoot}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="operator-asserted seal">
          <span className="mono text-xs">{new Date(s.sealedAt).toLocaleString()}</span>
        </Stat>
        <Stat label="actions sealed">{s.count}</Stat>
      </div>
      {beforeDeadline !== null && (
        <div className={`text-xs ${beforeDeadline ? "text-teal" : "text-danger"}`}>
          {beforeDeadline ? "✓ sealed before the deadline" : "✗ sealed after the deadline"}{" "}
          <span className="text-faint">(operator-asserted seal time)</span>
        </div>
      )}

      <div className="border-t border-edge pt-3 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-faint">Witness quorum</div>
        <div className="flex items-center gap-2">
          <Pill tone="teal">{isS3 ? "S3 Object Lock" : "In-memory WORM"}</Pill>
          <span className="text-xs text-ink">
            {witness.worm.mode}
            {isS3 ? "" : " (emulated)"}
          </span>
          <span className="text-[10px] text-faint ml-auto mono">{witness.worm.key}</span>
        </div>
        <div className="text-[10px] text-faint">
          immutable until {new Date(witness.worm.retainUntil).toLocaleDateString()} ·{" "}
          {isS3 ? "not even the account root can delete it" : "overwrite-refusing (emulates S3 Object Lock)"}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <Pill tone="teal">Timestamp authority</Pill>
          <span className="text-xs text-ink">Ed25519</span>
          <Hash value={witness.tsa.publicKey} chars={6} className="ml-auto" />
        </div>
        <div className="text-[10px] text-faint">
          co-signs the frozen root · {witness.tsa.authority} · verifiable offline against its published key
        </div>
        <div className="text-[10px] text-faint">
          authority key operator-held in this build · production = separate trust domain (KMS)
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button tone="primary" size="sm" onClick={onReveal} disabled={revealing || revealed === total}>
          {revealed === total ? `Revealed ${revealed}/${total}` : revealing ? "Revealing…" : `Reveal actions (${revealed}/${total})`}
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
  forge,
  onRun,
  running,
  auctionId,
}: {
  sealed: boolean;
  result: VerificationResult | null;
  forge: ForgeState | null;
  onRun: () => void;
  running: boolean;
  auctionId: string;
}) {
  return (
    <div className="card p-5">
      <SectionTitle title="Offline verifier" role="Auditor" hint="in-browser · no network" />
      <p className="text-xs text-muted mb-3">
        Rebuilds the proof from the revealed actions and checks the signature against the{" "}
        <span className="text-ink">published authority key</span> — entirely in your browser, no server,
        no network. The same code a regulator or a court would run.
      </p>

      {forge && (
        <div className="rounded-lg border border-gold/40 bg-gold/5 p-3 mb-3">
          <div className="text-xs font-semibold text-gold mb-1.5">
            Operator&apos;s console — <span className="mono">{forge.result.label}()</span>:{" "}
            {forge.result.originalDetail} → {forge.result.newDetail}
          </div>
          <div className="space-y-0.5 mb-1.5">
            {forge.operator.checks.map((c) => (
              <div key={c.label} className="flex items-center gap-2 text-[11px]">
                <span className="text-teal">✓</span>
                <span className="text-muted">{c.label}</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-teal font-medium">✓ all records consistent</div>
          <div className="text-[10px] text-faint mt-1">
            …on the operator&apos;s own screen. Don&apos;t trust theirs — run yours:
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <Button tone="primary" size="sm" onClick={onRun} disabled={!sealed || running}>
          {running ? "Verifying…" : forge ? "Run verifier on your own machine" : "Run verifier"}
        </Button>
        <Link
          href={`/verify?session=${auctionId}`}
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
            {result.valid ? "✓ VALID — proof holds" : "✗ INVALID — forgery caught"}
          </div>
          <div className="space-y-1">
            {result.checks.map((c) => (
              <div key={c.label} className="flex items-start gap-2 text-[11px]">
                <span className={c.ok ? "text-teal" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span className={`flex-1 ${c.ok ? "text-muted" : "text-danger font-medium"}`}>
                  {c.label}
                </span>
              </div>
            ))}
          </div>
          {!result.valid && forge && (
            <div className="text-[10px] text-faint mt-2 border-t border-edge pt-2">
              Internally flawless — but not signed by the published authority. (In this build the
              authority key is operator-held; production runs it in a separate trust domain, e.g. KMS,
              so the operator literally cannot sign.)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LedgerPanel({ events, auctionId }: { events: AuditEvent[]; auctionId: string }) {
  const pk = `SESSION#${auctionId.slice(0, 8)}…`;
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
      sk: `ACTION#${String(event.detail.seq).padStart(3, "0")}`,
      color: "text-ink",
      op: "PutItem · IF status=OPEN",
    },
    BID_REVEALED: {
      sk: `ACTION#${String(event.detail.seq).padStart(3, "0")}`,
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
