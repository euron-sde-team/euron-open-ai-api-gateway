"use client";

import Link from "next/link";
import { cn } from "@open-gateway/ui";
import { useProductName } from "@/lib/meta";

/** Split for the two-tone wordmark: all but the last word strong, the last word muted. */
export function splitName(name: string): { lead: string; tail: string } {
  const t = name.trim();
  const i = t.lastIndexOf(" ");
  return i < 0 ? { lead: t, tail: "" } : { lead: t.slice(0, i), tail: t.slice(i + 1) };
}

export function LogoMark({ className }: { className?: string }) {
  // One key, many providers: a single source node fanning out to three routes, the primary one lit.
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8 shrink-0", className)}>
      <rect width="32" height="32" rx="9" className="fill-ink" />
      <path d="M10 16 C15 16 15 9.5 21 9.5 M10 16 C15 16 15 22.5 21 22.5" fill="none" strokeWidth="1.9" strokeLinecap="round" className="stroke-ink-foreground" />
      <path d="M10 16 H21" fill="none" strokeWidth="1.9" strokeLinecap="round" className="stroke-brand" />
      <circle cx="9" cy="16" r="2.6" className="fill-ink-foreground" />
      <circle cx="22.5" cy="9.5" r="2" className="fill-ink-foreground" />
      <circle cx="22.5" cy="16" r="2.3" className="fill-brand" />
      <circle cx="22.5" cy="22.5" r="2" className="fill-ink-foreground" />
    </svg>
  );
}

export function Wordmark({ compact, className, textClassName }: { compact?: boolean; className?: string; textClassName?: string }) {
  const name = useProductName();
  const { lead, tail } = splitName(name);
  return (
    <Link href="/" className={cn("flex min-w-0 items-center gap-2 rounded-md focus-visible:ring-2", className)} aria-label={`${name} home`}>
      <LogoMark />
      {compact ? null : (
        <span className={cn("truncate font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground", textClassName)}>
          {lead}
          {tail ? <span className="font-semibold text-muted-foreground"> {tail}</span> : null}
        </span>
      )}
    </Link>
  );
}
