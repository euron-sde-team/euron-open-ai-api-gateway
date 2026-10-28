"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { RequestRow } from "@open-gateway/types";
import { NativeSelect } from "@open-gateway/ui";
import { api } from "@/lib/api";
import { requestStatus, useKeys, useRequests } from "@/lib/console";
import { msLabel, tokensLabel, usd } from "@/lib/money";
import { qk } from "@/lib/query-keys";
import { TimeAgo } from "@/components/common/time-ago";
import { DataTable, DetailSection, DetailSheet, FactList, StatusText, type Column } from "@/components/admin/shell";
import { CodeBlock, ConsolePage } from "./page";

const TONE = { ok: "success", warn: "warning", error: "danger" } as const;

export function UsagePage() {
  const params = useSearchParams();
  const router = useRouter();
  const keys = useKeys();
  const filters = useMemo(
    () => ({
      apiKeyId: params.get("key") ?? undefined,
      modelId: params.get("model") ?? undefined,
      status: (params.get("status") as "ok" | "error" | null) ?? undefined,
    }),
    [params],
  );
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v) next.set(k, v);
    else next.delete(k);
    router.replace(`/usage${next.size ? `?${next}` : ""}`);
  };
  const list = useRequests(filters);
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [open, setOpen] = useState<string | null>(null);

  const columns: Column<RequestRow>[] = [
    { key: "when", header: "When", cell: (r) => <TimeAgo value={r.createdAt} className="text-muted-foreground" /> },
    {
      key: "model",
      header: "Model",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{r.modelId}</span>
          <span className="block truncate text-[12.5px] text-subtle-foreground">
            {r.endpoint}
            {r.stream ? ", streamed" : ""}
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => {
        const s = requestStatus(r.statusCode, r.errorCode);
        return <StatusText tone={TONE[s.tone]}>{s.text}</StatusText>;
      },
    },
    { key: "key", header: "Key", hideBelow: "lg", cell: (r) => <span className="text-muted-foreground">{r.apiKeyName ?? "Deleted key"}</span> },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      hideBelow: "md",
      cell: (r) => (r.units ? <span className="tabular-nums">{r.units.toLocaleString()} units</span> : <span className="tabular-nums">{tokensLabel(r.inputTokens)} / {tokensLabel(r.outputTokens)}</span>),
    },
    { key: "latency", header: "Latency", align: "right", hideBelow: "md", cell: (r) => <span className="tabular-nums text-muted-foreground">{msLabel(r.latencyMs)}</span> },
    { key: "price", header: "Price", align: "right", cell: (r) => <span className="tabular-nums">{usd(r.priceMicros)}</span> },
  ];

  return (
    <ConsolePage title="Usage" description="Every request with its tokens, latency and exact price. Request and response bodies are kept only for keys that log them." testId="usage-page" wide>
      <div className="mb-5 flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
          Key
          <NativeSelect className="h-9 w-48" value={filters.apiKeyId ?? ""} onChange={(e) => setFilter("key", e.target.value)} aria-label="Filter by key">
            <option value="">All keys</option>
            {keys.data?.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
          Status
          <NativeSelect className="h-9 w-36" value={filters.status ?? ""} onChange={(e) => setFilter("status", e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            <option value="ok">Succeeded</option>
            <option value="error">Failed</option>
          </NativeSelect>
        </label>
      </div>
      <DataTable<RequestRow>
        caption="Requests"
        rows={rows}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        columns={columns}
        onRowClick={(r) => setOpen(r.id)}
        selectedKey={open}
        hasMore={!!list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        empty={{ title: "No requests", description: filters.apiKeyId || filters.status ? "Nothing matches these filters." : "Calls made with your keys appear here within seconds." }}
      />
      <RequestSheet id={open} onClose={() => setOpen(null)} />
    </ConsolePage>
  );
}

function RequestSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: qk.request(id ?? ""), queryFn: () => api().usage.request(id!), enabled: !!id });
  const r = q.data;
  const status = r ? requestStatus(r.statusCode, r.errorCode) : null;
  return (
    <DetailSheet open={!!id} onOpenChange={(o) => !o && onClose()} title={r?.modelId ?? ""} description={r ? <span className="font-mono">{r.id}</span> : undefined} loading={q.isLoading} error={q.isError ? q.error : undefined} testId="request-sheet">
      {r ? (
        <>
          <DetailSection title="Request">
            <FactList
              items={[
                { label: "Status", value: status ? <StatusText tone={TONE[status.tone]}>{status.text}</StatusText> : null },
                { label: "Endpoint", value: `${r.endpoint}${r.stream ? " (streamed)" : ""}` },
                { label: "Key", value: r.apiKeyName ?? "Deleted key" },
                { label: "When", value: new Date(r.createdAt).toLocaleString() },
                { label: "Attempts", value: r.attempts > 1 ? `${r.attempts} (failed over)` : "1" },
                { label: "Latency", value: msLabel(r.latencyMs) || "None" },
                ...(r.ttfbMs !== null ? [{ label: "First token", value: msLabel(r.ttfbMs) }] : []),
              ]}
            />
          </DetailSection>
          <DetailSection title="Billing">
            <FactList
              items={[
                ...(r.units ? [{ label: "Units", value: r.units.toLocaleString() }] : [{ label: "Input tokens", value: r.inputTokens.toLocaleString() }, { label: "Output tokens", value: r.outputTokens.toLocaleString() }]),
                ...(r.cachedTokens ? [{ label: "Cached input tokens", value: r.cachedTokens.toLocaleString() }] : []),
                { label: "Price", value: usd(r.priceMicros) },
                ...(r.estimated ? [{ label: "Note", value: "The provider reported no usage (the stream ended early), so tokens were estimated." }] : []),
              ]}
            />
          </DetailSection>
          <DetailSection title="Bodies">
            {r.bodies ? (
              <div className="space-y-3">
                <CodeBlock language="Request" code={JSON.stringify(r.bodies.request, null, 2)} />
                <CodeBlock language="Response" code={JSON.stringify(r.bodies.response, null, 2)} />
              </div>
            ) : (
              <p className="text-[13.5px] text-muted-foreground">Not kept. Turn on &ldquo;Keep request and response bodies&rdquo; for a key to see them here for a few days.</p>
            )}
          </DetailSection>
        </>
      ) : null}
    </DetailSheet>
  );
}

