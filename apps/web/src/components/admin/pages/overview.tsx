"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminStats } from "@open-gateway/types";
import { api } from "@/lib/api";
import { RANGE_PRESETS, formatCount, parsePreset, percentLabel, presetRange, type RangePreset } from "@/lib/admin";
import { msLabel, tokensLabel, usd } from "@/lib/money";
import { ErrorState } from "@/components/common/states";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { AdminPage, AdminSection, Chart, DataTable, StatLine, useUrlState, type Column, type StatItem } from "../shell";
import { ak } from "./common";

type ModelRow = AdminStats["byModel"][number];
type ProviderRow = AdminStats["byProvider"][number];

const dash = <span className="text-subtle-foreground">None</span>;
const ms = (v: number | null) => (v === null ? dash : msLabel(v));

export function AdminOverview() {
  const url = useUrlState();
  const preset = parsePreset(url.get("range"));
  const range = useMemo(() => presetRange(preset), [preset]);
  const q = useQuery({
    queryKey: ak.stats(range),
    queryFn: () => api().admin.stats(range),
    placeholderData: (p) => p,
  });
  const s = q.data;
  // The chart reads plain numbers: revenue in dollars.
  const daily = useMemo(() => (s?.daily ?? []).map((d) => ({ date: d.date, requests: d.requests, errors: d.errors, revenue: d.revenueMicros / 1_000_000, cost: d.costMicros / 1_000_000 })), [s]);

  return (
    <AdminPage
      title="Overview"
      description="Traffic, money and latency across the gateway. Days are counted in UTC. Revenue is what callers paid; provider cost is what the routes cost the platform."
      filters={
        <UnderlineTabs<`${RangePreset}`>
          tabs={RANGE_PRESETS.map((d) => ({ value: `${d}` as const, label: `Last ${d} days` }))}
          value={`${preset}`}
          onChange={(v) => url.set({ range: v === "30" ? null : v })}
          label="Date range"
        />
      }
      testId="admin-overview"
    >
      {q.isError && !s ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className={q.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <StatLine loading={!s} size="lg" items={totals(s)} testId="overview-totals" />
          <AdminSection title="By day" id="daily" className="mt-10">
            {s ? (
              <div className="grid gap-8 lg:grid-cols-2">
                <Chart
                  data={daily}
                  series={[
                    { key: "requests", label: "Requests", tone: "primary" },
                    { key: "errors", label: "Errors", tone: "danger" },
                  ]}
                  type="bar"
                  title="Requests and errors per day"
                  testId="overview-requests-chart"
                />
                <Chart
                  data={daily}
                  series={[
                    { key: "revenue", label: "Revenue", tone: "success" },
                    { key: "cost", label: "Provider cost", tone: "muted" },
                  ]}
                  title="Revenue and provider cost per day, US dollars"
                  formatValue={(n) => usd(Math.round(n * 1_000_000))}
                  integer={false}
                  testId="overview-revenue-chart"
                />
              </div>
            ) : (
              <div className="h-[240px] animate-shimmer rounded-md bg-muted" aria-hidden />
            )}
          </AdminSection>
          <ByModel stats={s} />
          <ByProvider stats={s} />
        </div>
      )}
    </AdminPage>
  );
}

export function totals(s: AdminStats | undefined): StatItem[] {
  const t = s?.totals;
  if (!t) return ["Requests", "Error rate", "Revenue", "Provider cost", "Gross margin", "Top-ups", "Credits granted", "Active accounts", "New users"].map((label) => ({ label, value: "" }));
  return [
    { label: "Requests", value: formatCount(t.requests), testId: "stat-requests" },
    { label: "Error rate", value: percentLabel(t.errors, t.requests) ?? "0%", hint: `${formatCount(t.errors)} errors`, testId: "stat-errors" },
    { label: "Revenue", value: usd(t.revenueMicros), testId: "stat-revenue" },
    { label: "Provider cost", value: usd(t.costMicros), testId: "stat-cost" },
    { label: "Gross margin", value: usd(t.marginMicros), hint: percentLabel(t.marginMicros, t.revenueMicros) ?? undefined, testId: "stat-margin" },
    { label: "Top-ups", value: usd(t.topupsMicros), href: "/admin/topups", testId: "stat-topups" },
    { label: "Credits granted", value: usd(t.creditsGrantedMicros), testId: "stat-credits" },
    { label: "Active accounts", value: formatCount(t.activeAccounts), hint: `of ${formatCount(t.users)}`, testId: "stat-active" },
    { label: "New users", value: formatCount(t.newUsers), href: "/admin/users", testId: "stat-new-users" },
  ];
}

function ByModel({ stats }: { stats: AdminStats | undefined }) {
  const columns = useMemo<Column<ModelRow>[]>(
    () => [
      { key: "model", header: "Model", cell: (r) => <span className="font-mono text-[13px] text-foreground">{r.modelId}</span>, sortValue: (r) => r.modelId },
      { key: "requests", header: "Requests", align: "right", cell: (r) => formatCount(r.requests), sortValue: (r) => r.requests },
      { key: "errors", header: "Errors", align: "right", cell: (r) => (r.errors ? <span className="text-danger">{formatCount(r.errors)}</span> : "0"), sortValue: (r) => r.errors, hideBelow: "sm" },
      { key: "in", header: "Tokens in", align: "right", cell: (r) => tokensLabel(r.inputTokens), sortValue: (r) => r.inputTokens, hideBelow: "lg" },
      { key: "out", header: "Tokens out", align: "right", cell: (r) => tokensLabel(r.outputTokens), sortValue: (r) => r.outputTokens, hideBelow: "lg" },
      { key: "revenue", header: "Revenue", align: "right", cell: (r) => usd(r.revenueMicros), sortValue: (r) => r.revenueMicros },
      { key: "cost", header: "Cost", align: "right", cell: (r) => usd(r.costMicros), sortValue: (r) => r.costMicros, hideBelow: "md" },
      {
        key: "margin",
        header: "Margin",
        align: "right",
        cell: (r) => {
          const m = r.revenueMicros - r.costMicros;
          return <span className={m < 0 ? "text-danger" : undefined}>{usd(m)}</span>;
        },
        sortValue: (r) => r.revenueMicros - r.costMicros,
        hideBelow: "md",
      },
      { key: "p50", header: "p50", align: "right", cell: (r) => ms(r.p50LatencyMs), sortValue: (r) => r.p50LatencyMs, hideBelow: "lg" },
      { key: "p95", header: "p95", align: "right", cell: (r) => ms(r.p95LatencyMs), sortValue: (r) => r.p95LatencyMs, hideBelow: "lg" },
      { key: "ttfb", header: "First token p50", align: "right", cell: (r) => ms(r.p50TtfbMs), sortValue: (r) => r.p50TtfbMs, hideBelow: "lg" },
    ],
    [],
  );
  return (
    <AdminSection title="By model" description="Latency is the whole request; first token is how long a stream took to send its first chunk." id="by-model" className="mt-10">
      <DataTable caption="Usage by model" rows={stats?.byModel ?? []} columns={columns} rowKey={(r) => r.modelId} loading={!stats} skeletonRows={4} empty={{ title: "No requests in this range." }} testId="overview-by-model" />
    </AdminSection>
  );
}

function ByProvider({ stats }: { stats: AdminStats | undefined }) {
  const columns = useMemo<Column<ProviderRow>[]>(
    () => [
      { key: "provider", header: "Provider", cell: (r) => <span className="font-mono text-[13px] text-foreground">{r.providerId}</span>, sortValue: (r) => r.providerId },
      { key: "requests", header: "Requests", align: "right", cell: (r) => formatCount(r.requests), sortValue: (r) => r.requests },
      { key: "errors", header: "Errors", align: "right", cell: (r) => (r.errors ? <span className="text-danger">{formatCount(r.errors)}</span> : "0"), sortValue: (r) => r.errors },
      { key: "failovers", header: "Failovers", align: "right", cell: (r) => formatCount(r.failovers), sortValue: (r) => r.failovers, hideBelow: "sm" },
      { key: "p50", header: "p50", align: "right", cell: (r) => ms(r.p50LatencyMs), sortValue: (r) => r.p50LatencyMs, hideBelow: "md" },
      { key: "p95", header: "p95", align: "right", cell: (r) => ms(r.p95LatencyMs), sortValue: (r) => r.p95LatencyMs, hideBelow: "md" },
    ],
    [],
  );
  return (
    <AdminSection title="By provider" description="A failover is a request this provider could not serve that moved to the next route." id="by-provider" className="mt-10">
      <DataTable caption="Usage by provider" rows={stats?.byProvider ?? []} columns={columns} rowKey={(r) => r.providerId} loading={!stats} skeletonRows={3} empty={{ title: "No provider traffic in this range." }} testId="overview-by-provider" />
    </AdminSection>
  );
}
