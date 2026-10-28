"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, IconButton, Skeleton, cn, toast } from "@open-gateway/ui";
import type { HealthRow } from "@open-gateway/types";
import { api } from "@/lib/api";
import { CIRCUIT_HINT, CIRCUIT_LABEL, CIRCUIT_TONE, adminErrorMessage, groupHealth, rateLabel } from "@/lib/admin";
import { msLabel } from "@/lib/money";
import { fullTimestamp } from "@/lib/time";
import { ErrorState } from "@/components/common/states";
import { TimeAgo } from "@/components/common/time-ago";
import { AdminPage, AdminSection, StatusText } from "../shell";
import { ak } from "./common";

const REFRESH_MS = 30_000;

export function AdminHealth() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.health, queryFn: () => api().admin.health(), refetchInterval: REFRESH_MS, refetchIntervalInBackground: false });
  const groups = useMemo(() => groupHealth(q.data ?? []), [q.data]);

  const circuit = useMutation({
    mutationFn: ({ routeId, state }: { routeId: string; state: "open" | "closed" }) => api().admin.setCircuit(routeId, state),
    meta: { silent: true },
    onMutate: ({ routeId, state }) => {
      // Instant: show the forced state while the request runs.
      const prev = qc.getQueryData<HealthRow[]>(ak.health);
      if (prev) qc.setQueryData<HealthRow[]>(ak.health, prev.map((r) => (r.routeId === routeId ? { ...r, circuit: state } : r)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ak.health, ctx.prev);
      toast.error({ title: adminErrorMessage(e) });
    },
    onSuccess: (_d, { state }) => {
      toast.success({ title: state === "open" ? "Circuit forced open: requests skip this route" : "Circuit closed: requests use this route again" });
      void qc.invalidateQueries({ queryKey: ak.health });
      void qc.invalidateQueries({ queryKey: ak.models });
    },
  });

  const open = (q.data ?? []).filter((r) => r.enabled && r.circuit !== "closed").length;

  return (
    <AdminPage
      title="Health"
      description="Every route with its circuit, the last 24 hours of traffic and the latest probes, oldest on the left. Refreshes every 30 seconds."
      actions={
        <IconButton label="Refresh now" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching} data-testid="health-refresh">
          <RefreshCw className={cn(q.isFetching && "animate-spin")} />
        </IconButton>
      }
      testId="admin-health"
    >
      {q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <div className="space-y-3 border-t border-border pt-6" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : !groups.length ? (
        <EmptyState compact title="No routes yet." description="Add a model and a route on the Models page." />
      ) : (
        <>
          <p className="mb-6 text-[14px] text-muted-foreground" aria-live="polite" data-testid="health-summary">
            {open ? <span className="text-warning">{open === 1 ? "1 enabled route is" : `${open} enabled routes are`} not taking traffic.</span> : "Every enabled route is taking traffic."}
            {q.dataUpdatedAt ? <span> Updated <TimeAgo value={new Date(q.dataUpdatedAt).toISOString()} />.</span> : null}
          </p>
          {groups.map((g) => (
            <AdminSection key={g.modelId} title={<span className="font-mono text-[16px]">{g.modelId}</span>} id={`health-${slugId(g.modelId)}`}>
              <ul className="border-b border-border" aria-label={`Routes for ${g.modelId}`}>
                {g.routes.map((r) => (
                  <RouteHealth key={r.routeId} row={r} busy={circuit.isPending && circuit.variables?.routeId === r.routeId} onForce={(state) => circuit.mutate({ routeId: r.routeId, state })} />
                ))}
              </ul>
            </AdminSection>
          ))}
        </>
      )}
    </AdminPage>
  );
}

const slugId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-");

function RouteHealth({ row: r, busy, onForce }: { row: HealthRow; busy: boolean; onForce: (state: "open" | "closed") => void }) {
  const rate = rateLabel(r.successRate24h);
  const low = r.successRate24h !== null && r.successRate24h < 0.95;
  return (
    <li className="flex flex-col gap-3 border-t border-border py-3.5 first:border-t-0 md:flex-row md:items-center md:gap-6" data-testid={`health-route-${r.routeId}`}>
      <div className="min-w-0 md:w-[34%]">
        <p className="text-[14px] text-foreground">
          <span className="mr-2 tabular-nums text-muted-foreground" title="Priority: lower is tried first">
            {r.priority}.
          </span>
          <span className="font-medium">{r.providerId}</span>
          <span className="text-muted-foreground"> · </span>
          <span className="break-all font-mono text-[13px]">{r.upstreamModel}</span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4">
          <span title={CIRCUIT_HINT[r.circuit]}>
            <StatusText tone={CIRCUIT_TONE[r.circuit]} testId={`health-circuit-${r.routeId}`}>
              Circuit {CIRCUIT_LABEL[r.circuit].toLowerCase()}
            </StatusText>
          </span>
          {!r.enabled ? <StatusText tone="muted">Route off</StatusText> : null}
        </div>
      </div>
      <dl className="flex gap-6 text-[13px] md:w-[22%]">
        <div>
          <dt className="text-muted-foreground">24h success</dt>
          <dd className={cn("font-semibold tabular-nums", low ? "text-danger" : "text-foreground")}>{rate ?? <span className="font-normal text-subtle-foreground">No traffic</span>}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">p50</dt>
          <dd className="font-semibold tabular-nums text-foreground">{r.p50LatencyMs24h === null ? <span className="font-normal text-subtle-foreground">None</span> : msLabel(r.p50LatencyMs24h)}</dd>
        </div>
      </dl>
      <ProbeMarks checks={r.checks} />
      <div className="flex shrink-0 gap-2 md:ml-auto">
        {r.circuit === "closed" ? (
          <Button variant="outline" size="sm" onClick={() => onForce("open")} loading={busy} aria-label={`Force open: the ${r.providerId} route for ${r.modelId}`} data-testid={`health-open-${r.routeId}`}>
            Force open
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => onForce("closed")} loading={busy} aria-label={`Close: the ${r.providerId} route circuit for ${r.modelId}`} data-testid={`health-close-${r.routeId}`}>
            Close
          </Button>
        )}
      </div>
    </li>
  );
}

/** The latest probes as small marks, oldest first, newest on the right. */
export function ProbeMarks({ checks }: { checks: HealthRow["checks"] }) {
  if (!checks.length) return <p className="text-[13px] text-subtle-foreground md:flex-1">No probes yet</p>;
  const ordered = [...checks].reverse();
  const failed = checks.filter((c) => !c.ok).length;
  return (
    <div className="md:flex-1">
      <ol className="flex items-end gap-1" aria-label={`Last ${checks.length} probes: ${failed} failed`} data-testid="probe-marks">
        {ordered.map((c) => (
          <li
            key={c.checkedAt}
            title={`${fullTimestamp(c.checkedAt)}: ${c.ok ? "ok" : "failed"}${c.latencyMs !== null ? `, ${msLabel(c.latencyMs)}` : ""}${c.error ? `. ${c.error}` : ""}`}
            className={cn("h-4 w-1.5 rounded-[1px]", c.ok ? "bg-success" : "bg-danger")}
            data-ok={c.ok ? "true" : "false"}
          />
        ))}
      </ol>
      {checks[0] && !checks[0].ok && checks[0].error ? <p className="mt-1 line-clamp-1 break-all text-[12px] text-danger">{checks[0].error}</p> : null}
    </div>
  );
}
