"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@open-gateway/ui";
import { PageBar } from "@/components/app/app-shell";

/** A console page: the top bar, a heading with an optional description and actions, then the content. */
export function ConsolePage({ title, description, actions, children, testId, wide }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string; wide?: boolean }) {
  return (
    <>
      <PageBar title={title} />
      <div className={cn("mx-auto w-full px-4 pb-20 pt-2 sm:px-6", wide ? "max-w-7xl" : "max-w-5xl")} data-testid={testId}>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
            {description ? <p className="mt-1.5 max-w-2xl text-[14.5px] leading-6 text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </div>
    </>
  );
}

/** A titled section separated by a hairline. */
export function Section({ title, description, actions, children, className, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn("mt-12 border-t border-border pt-6 first:mt-0 first:border-t-0 first:pt-0", className)} aria-labelledby={id ? `${id}-title` : undefined} id={id}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="text-[16px] font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description ? <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
  ];
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" onClick={() => copy(text)} aria-label={copied ? "Copied" : label} className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-subtle-foreground hover:bg-muted hover:text-foreground", className)}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Code on a quiet ground, with a copy action. */
export function CodeBlock({ code, language, className, testId }: { code: string; language?: string; className?: string; testId?: string }) {
  return (
    <div className={cn("group relative rounded-lg bg-ground-2", className)} data-testid={testId}>
      <div className="flex items-center justify-between px-3 pt-2 text-[12px] text-subtle-foreground">
        <span>{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-4 pb-4 pt-1 font-mono text-[12.5px] leading-[1.65] text-foreground scrollbar-thin">
        <code>{code}</code>
      </pre>
    </div>
  );
}
