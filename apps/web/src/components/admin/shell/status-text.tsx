"use client";

import type { ReactNode } from "react";
import { cn } from "@open-gateway/ui";

export type DotTone = "success" | "warning" | "danger" | "muted" | "primary";

const DOT: Record<DotTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  muted: "bg-subtle-foreground/60",
  primary: "bg-primary",
};

/** A small coloured dot (decorative: the text next to it carries the meaning). */
export function Dot({ tone, className }: { tone: DotTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT[tone], className)} />;
}

/** A status as plain text with a small dot. No pill, no box. */
export function StatusText({ tone, children, className, testId }: { tone: DotTone; children: ReactNode; className?: string; testId?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13.5px]", tone === "muted" ? "text-muted-foreground" : "text-foreground", className)} data-testid={testId}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}
