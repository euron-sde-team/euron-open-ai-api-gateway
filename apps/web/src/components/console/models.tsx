"use client";

import { useMemo, useState } from "react";
import type { ModelInfo, ModelKind } from "@open-gateway/types";
import { Input, Segmented } from "@open-gateway/ui";
import { KIND_ENDPOINT, KIND_LABEL, priceParts, useCatalog } from "@/lib/console";
import { useAppMeta } from "@/lib/meta";
import { inr } from "@/lib/money";
import { ErrorState } from "@/components/common/states";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { CopyButton, ConsolePage } from "./page";

type KindTab = "ALL" | ModelKind;

/** "$2.50 / 1M" in USD, or the same price in rupees at today's rate. */
function inCurrency(value: string, currency: "USD" | "INR", rate: number): string {
  if (currency === "USD") return value;
  const m = /\$([\d,.]+)/.exec(value);
  if (!m) return value;
  return value.replace(m[0], inr(Number(m[1]!.replace(/,/g, "")) * rate));
}

export function ModelsPage() {
  const catalog = useCatalog();
  const meta = useAppMeta();
  const [kind, setKind] = useState<KindTab>("ALL");
  const [query, setQuery] = useState("");
  const [currency, setCurrency] = useState<"USD" | "INR">("USD");
  const rate = meta.data?.billing.inrPerUsd ?? 0;

  const kinds = useMemo(() => {
    const present = new Set(catalog.data?.map((m) => m.kind));
    return (["CHAT", "EMBEDDING", "IMAGE", "SPEECH", "TRANSCRIPTION"] as const).filter((k) => present.has(k));
  }, [catalog.data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog.data ?? []).filter((m) => (kind === "ALL" || m.kind === kind) && (!q || [m.id, m.displayName, m.ownedBy, ...m.aliases].some((s) => s.toLowerCase().includes(q))));
  }, [catalog.data, kind, query]);

  return (
    <ConsolePage
      title="Models"
      description="Every model your keys can call, with the price you pay. Use the id (or an alias) as the model name in your requests."
      actions={rate ? <Segmented<"USD" | "INR"> value={currency} onChange={setCurrency} options={[{ value: "USD", label: "USD" }, { value: "INR", label: "INR" }]} aria-label="Currency" /> : null}
      testId="models-page"
      wide
    >
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <UnderlineTabs<KindTab> tabs={[{ value: "ALL", label: "All" }, ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))]} value={kind} onChange={setKind} label="Model kind" />
        <Input className="h-9 w-64" placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search models" />
      </div>
      {catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : catalog.isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-14 animate-shimmer rounded-md bg-muted" />
          ))}
        </div>
      ) : !rows.length ? (
        <p className="py-10 text-center text-[14px] text-muted-foreground">{catalog.data?.length ? "No model matches." : "No models are available yet. An administrator adds them."}</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border" data-testid="model-list">
          {rows.map((m) => (
            <ModelLine key={m.id} m={m} currency={currency} rate={rate} />
          ))}
        </ul>
      )}
      {currency === "INR" && rate ? <p className="mt-4 text-[12.5px] text-subtle-foreground">Rupee prices use today&rsquo;s rate of {inr(rate)} per US dollar. Your balance is kept and charged in US dollars.</p> : null}
    </ConsolePage>
  );
}

function ModelLine({ m, currency, rate }: { m: ModelInfo; currency: "USD" | "INR"; rate: number }) {
  const caps = [m.supportsTools && "tools", m.supportsVision && "vision", m.supportsJson && "JSON mode", m.routes > 1 && `${m.routes} providers with failover`].filter(Boolean);
  return (
    <li className="grid gap-3 py-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:gap-8" data-testid={`model-${m.id}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <code className="truncate font-mono text-[14px] font-medium">{m.id}</code>
          <CopyButton text={m.id} label="Copy id" />
        </div>
        <p className="mt-0.5 text-[13.5px] text-muted-foreground">
          {m.displayName}
          {m.ownedBy ? ` by ${m.ownedBy}` : ""}. {m.description}
        </p>
        <p className="mt-1 text-[12.5px] text-subtle-foreground">
          {KIND_LABEL[m.kind]} on {KIND_ENDPOINT[m.kind]}
          {m.contextWindow ? `, ${m.contextWindow.toLocaleString()} token context` : ""}
          {caps.length ? `, ${caps.join(", ")}` : ""}
          {m.aliases.length ? `. Also: ${m.aliases.join(", ")}` : ""}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1 text-[13.5px]">
        {priceParts(m.kind, m.price).map((p) => (
          <div key={p.label} className="contents">
            <dt className="text-muted-foreground">{p.label}</dt>
            <dd className="text-right tabular-nums">{inCurrency(p.value, currency, rate)}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
