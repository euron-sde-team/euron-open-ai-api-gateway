"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { UsageSummary } from "@open-gateway/types";
import { Button } from "@open-gateway/ui";
import { lastDays, useCatalog, useKeys, useUsageSummary, useWallet } from "@/lib/console";
import { useAppMeta } from "@/lib/meta";
import { msLabel, tokensLabel, usd } from "@/lib/money";
import { snippet } from "@/lib/snippets";
import { useAuth } from "@/lib/auth";
import { ErrorState } from "@/components/common/states";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { Chart, DataTable, StatLine, type Column, type StatItem } from "@/components/admin/shell";
import { CodeBlock, ConsolePage, Section } from "./page";

const RANGES = ["7", "30", "90"] as const;
type ModelRow = UsageSummary["byModel"][number];

export function Overview() {
  const { user } = useAuth();
  const [range, setRange] = useState<(typeof RANGES)[number]>("30");
  const q = useMemo(() => lastDays(Number(range)), [range]);
  const summary = useUsageSummary(q);
  const wallet = useWallet();
  const keys = useKeys();
  const s = summary.data;
  const firstRun = keys.data && !keys.data.some((k) => k.status === "ACTIVE") && s && s.totals.requests === 0;

  return (
    <ConsolePage
      title={user ? `Hello, ${user.displayName.split(" ")[0]}` : "Overview"}
      description="Spend, traffic and latency across your keys. Days are counted in UTC."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href="/billing">Top up</Link>
        </Button>
      }
      testId="console-overview"
      wide
    >
      {firstRun ? <GettingStarted /> : null}
      <StatLine
        size="lg"
        loading={!s || !wallet.data}
        items={
          [
            { label: "Available balance", value: wallet.data ? usd(wallet.data.availableMicros) : "", hint: wallet.data?.reservedMicros ? `${usd(wallet.data.reservedMicros)} on hold` : undefined, href: "/billing" },
            { label: `Spend, last ${range} days`, value: s ? usd(s.totals.spendMicros) : "" },
            { label: "Requests", value: s ? s.totals.requests.toLocaleString() : "", hint: s && s.totals.errors ? `${s.totals.errors.toLocaleString()} errors` : undefined, href: "/usage" },
            { label: "Tokens", value: s ? tokensLabel(s.totals.inputTokens + s.totals.outputTokens) : "", hint: s ? `${tokensLabel(s.totals.inputTokens)} in, ${tokensLabel(s.totals.outputTokens)} out` : undefined },
            { label: "Average latency", value: s?.totals.avgLatencyMs != null ? msLabel(s.totals.avgLatencyMs) : "None yet" },
          ] satisfies StatItem[]
        }
        testId="overview-totals"
      />

      <Section
        title="By day"
        className="mt-12"
        actions={<UnderlineTabs tabs={RANGES.map((r) => ({ value: r, label: `${r} days` }))} value={range} onChange={setRange} label="Date range" />}
      >
        {summary.isError && !s ? (
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        ) : s ? (
          <div className={summary.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
            <Chart data={s.daily.map((d) => ({ ...d, spend: d.spendMicros / 1_000_000 }))} series={[{ key: "spend", label: "Spend (USD)", tone: "primary" }]} type="bar" title="Spend per day" integer={false} formatValue={(n) => usd(Math.round(n * 1_000_000))} testId="overview-spend-chart" />
            <Chart data={s.daily} series={[{ key: "requests", label: "Requests", tone: "primary" }, { key: "errors", label: "Errors", tone: "muted" }]} title="Requests and errors per day" className="mt-8" testId="overview-requests-chart" />
          </div>
        ) : (
          <div className="h-[240px] animate-shimmer rounded-md bg-muted" aria-hidden />
        )}
      </Section>

      <Section title="By model">
        <DataTable<ModelRow>
          caption="Spend by model"
          rows={s?.byModel ?? []}
          loading={!s}
          rowKey={(r) => r.modelId}
          columns={MODEL_COLUMNS}
          empty={{ title: "No requests yet", description: "Calls you make with your keys show up here within seconds." }}
        />
      </Section>

      {s && s.byKey.length ? (
        <Section title="By key">
          <ul className="divide-y divide-border">
            {s.byKey.map((k) => (
              <li key={k.apiKeyId ?? "none"} className="flex items-baseline justify-between gap-4 py-2.5 text-[14px]">
                <Link href={k.apiKeyId ? `/usage?key=${k.apiKeyId}` : "/usage"} className="min-w-0 truncate hover:underline">
                  {k.name}
                </Link>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {k.requests.toLocaleString()} requests <span className="ml-3 text-foreground">{usd(k.spendMicros)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </ConsolePage>
  );
}

const MODEL_COLUMNS: Column<ModelRow>[] = [
  { key: "model", header: "Model", cell: (r) => <span className="font-medium">{r.modelId}</span>, sortValue: (r) => r.modelId },
  { key: "requests", header: "Requests", align: "right", cell: (r) => r.requests.toLocaleString(), sortValue: (r) => r.requests },
  { key: "in", header: "Input tokens", align: "right", hideBelow: "md", cell: (r) => tokensLabel(r.inputTokens), sortValue: (r) => r.inputTokens },
  { key: "out", header: "Output tokens", align: "right", hideBelow: "md", cell: (r) => tokensLabel(r.outputTokens), sortValue: (r) => r.outputTokens },
  { key: "spend", header: "Spend", align: "right", cell: (r) => usd(r.spendMicros), sortValue: (r) => r.spendMicros },
];

/** Three steps for an account with no key and no traffic yet. */
function GettingStarted() {
  const meta = useAppMeta();
  const catalog = useCatalog();
  const model = catalog.data?.find((m) => m.kind === "CHAT")?.id ?? "your-model";
  return (
    <div className="mb-12 border-b border-border pb-10" data-testid="getting-started">
      <h2 className="font-display text-[20px] font-semibold tracking-[-0.015em]">Make your first request</h2>
      <ol className="mt-5 grid gap-8 md:grid-cols-3">
        <li>
          <p className="text-[13px] font-semibold text-subtle-foreground">1</p>
          <p className="mt-1 font-medium">Create an API key</p>
          <p className="mt-1 text-[13.5px] text-muted-foreground">One key reaches every model in the catalogue. Limit it to some models, a budget or your servers&rsquo; addresses if you like.</p>
          <Link href="/keys?new=1" className="mt-2 inline-flex items-center gap-1 text-[14px] font-medium text-primary hover:underline">
            Create a key <ArrowRight className="size-4" />
          </Link>
        </li>
        <li>
          <p className="text-[13px] font-semibold text-subtle-foreground">2</p>
          <p className="mt-1 font-medium">Point your SDK at the gateway</p>
          <p className="mt-1 text-[13.5px] text-muted-foreground">Any OpenAI or Anthropic SDK works: change the base URL and the key, keep your code.</p>
          <Link href="/docs" className="mt-2 inline-flex items-center gap-1 text-[14px] font-medium text-primary hover:underline">
            Read the quickstart <ArrowRight className="size-4" />
          </Link>
        </li>
        <li>
          <p className="text-[13px] font-semibold text-subtle-foreground">3</p>
          <p className="mt-1 font-medium">Watch it here</p>
          <p className="mt-1 text-[13.5px] text-muted-foreground">Every call shows its tokens, latency and exact price on the Usage page, and is paid from your balance.</p>
        </li>
      </ol>
      {meta.data ? <CodeBlock className="mt-6" language="curl" code={snippet("curl", { baseUrl: meta.data.gatewayBaseUrl, keyPrefix: meta.data.keyPrefix, model })} /> : null}
    </div>
  );
}
