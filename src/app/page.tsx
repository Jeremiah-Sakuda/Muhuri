import Link from "next/link";
import AuctionRoom from "@/components/AuctionRoom";
import { backendName } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function Home() {
  const backend = backendName();
  const region = process.env.AWS_REGION ?? "local";
  return (
    <div className="max-w-6xl mx-auto px-5 py-7">
      <header className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="text-2xl" aria-hidden>
              🪔
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Muhuri</h1>
            <span className="chip text-muted border-edge2 ml-1">notary</span>
          </div>
          <p className="text-sm text-muted mt-2 max-w-2xl">
            A tamper-evident notary for sealed-bid auctions. Prove a set of bids happened{" "}
            <span className="text-ink">in a specific order, before a deadline</span> — verifiable by
            anyone, <span className="text-ink">without trusting the operator</span>.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-2 justify-end">
            <span
              className={`chip ${
                backend === "dynamo" ? "text-teal border-teal/40" : "text-muted border-edge2"
              }`}
            >
              {backend === "dynamo" ? "● DynamoDB" : "○ memory"}
            </span>
            <span className="chip text-faint border-edge2 mono">{region}</span>
          </div>
          <Link
            href="/verify"
            className="text-xs text-muted hover:text-ink underline inline-block mt-2"
          >
            public verifier →
          </Link>
        </div>
      </header>

      <AuctionRoom />

      <footer className="mt-10 pt-5 border-t border-edge text-xs text-faint flex flex-wrap gap-x-4 gap-y-1">
        <span>
          seal = atomic <span className="mono">TransactWriteItems</span> +{" "}
          <span className="mono">ConditionExpression</span>
        </span>
        <span>witness = S3 Object Lock (COMPLIANCE) + Ed25519 timestamp authority</span>
        <span>verifier = offline, zero AWS credentials</span>
      </footer>
    </div>
  );
}
