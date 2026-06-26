"use client";

import { useState, type ReactNode } from "react";

/** Truncated, monospace hash that copies on click. */
export function Hash({ value, chars = 7, className = "" }: { value: string; chars?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text =
    value.length > chars * 2 + 1 ? `${value.slice(0, chars)}…${value.slice(-chars)}` : value;
  return (
    <button
      type="button"
      title={`${value}\n(click to copy)`}
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 900);
      }}
      className={`mono text-xs text-cyan hover:text-teal transition-colors cursor-pointer ${className}`}
    >
      {copied ? "copied!" : text}
    </button>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "open" | "sealed" | "danger" | "teal" | "gold";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "text-muted border-edge2",
    open: "text-teal border-teal/40 bg-teal/5",
    sealed: "text-gold border-gold/40 bg-gold/5",
    danger: "text-danger border-danger/40 bg-danger/5",
    teal: "text-teal border-teal/40",
    gold: "text-gold border-gold/40",
  };
  return <span className={`chip ${tones[tone]}`}>{children}</span>;
}

export function RoleChip({ role }: { role: "Agent" | "Operator" | "Auditor" }) {
  const colors: Record<string, string> = {
    Agent: "text-cyan border-cyan/30",
    Operator: "text-gold border-gold/30",
    Auditor: "text-teal border-teal/30",
  };
  return (
    <span className={`chip ${colors[role]} uppercase tracking-wider`} style={{ fontSize: 10 }}>
      {role}
    </span>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-faint mb-1">{label}</div>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = "default",
  size = "md",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger" | "ghost" | "gold";
  size?: "sm" | "md";
  type?: "button" | "submit";
}) {
  const tones: Record<string, string> = {
    default: "bg-panel2 border-edge2 text-ink hover:border-teal/50",
    primary: "bg-teal/15 border-teal/50 text-teal hover:bg-teal/25",
    gold: "bg-gold/15 border-gold/50 text-gold hover:bg-gold/25",
    danger: "bg-danger/10 border-danger/40 text-danger hover:bg-danger/20",
    ghost: "bg-transparent border-transparent text-muted hover:text-ink",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
        size === "sm" ? "text-xs px-2.5 py-1.5" : "text-sm px-3.5 py-2"
      } ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function SectionTitle({
  title,
  role,
  hint,
}: {
  title: string;
  role?: "Agent" | "Operator" | "Auditor";
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {role && <RoleChip role={role} />}
      {hint && <span className="text-xs text-faint ml-auto">{hint}</span>}
    </div>
  );
}
