"use client";

import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { flattenPages, nextCursor } from "@open-gateway/api-client";
import { ChevronRight, X } from "lucide-react";
import { Button, EmptyState, Skeleton, Spinner, cn } from "@open-gateway/ui";
import type { AuditEntry } from "@open-gateway/types";
import { api } from "@/lib/api";
import { humanizeAction, prettyJson } from "@/lib/admin";
import { fullTimestamp, relativeTime } from "@/lib/time";
import { ErrorState } from "@/components/common/states";
import { AdminPage, FilterBar, SearchInput, useUrlState } from "../shell";
import { ak, PersonAvatar } from "./common";

export const AUDIT_GROUPS = [
  { value: "all", label: "Everything", prefix: "" },
  { value: "user", label: "Accounts", prefix: "user." },
  { value: "key", label: "Keys", prefix: "key." },
  { value: "wallet", label: "Credit", prefix: "wallet." },
  { value: "topup", label: "Top-ups", prefix: "topup." },
  { value: "promo", label: "Promos", prefix: "promo." },
  { value: "provider", label: "Providers", prefix: "provider." },
  { value: "credential", label: "Credentials", prefix: "credential." },
  { value: "model", label: "Models", prefix: "model." },
  { value: "route", label: "Routes", prefix: "route." },
  { value: "tier", label: "Tiers", prefix: "tier." },
  { value: "settings", label: "Settings", prefix: "settings." },
] as const;
type Group = (typeof AUDIT_GROUPS)[number]["value"];

/** The action prefix to query: a typed prefix wins over the group tab. */
export function auditAction(group: string, custom: string): string {
  if (custom.trim()) return custom.trim();
  return AUDIT_GROUPS.find((g) => g.value === group)?.prefix ?? "";
}

export function AdminAudit() {
  const url = useUrlState();
  const groupParam = url.get("group");
  const group: Group = AUDIT_GROUPS.some((g) => g.value === groupParam) ? (groupParam as Group) : "all";
  const custom = url.get("action");
  const action = auditAction(group, custom);
  const actorId = url.get("actor");
  const actorName = url.get("actorName");
  const entityType = url.get("entityType");
  const entityId = url.get("entityId");
  const f = { action, actorId, entityType, entityId };
  const list = useInfiniteQuery({
    queryKey: ak.audit(f),
    queryFn: ({ pageParam }) => api().admin.audit({ action: action || undefined, actorId: actorId || undefined, entityType: entityType || undefined, entityId: entityId || undefined, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
  });
  const items = flattenPages(list.data?.pages);
  const active: { key: string; label: string; clear: Record<string, null> }[] = [];
  if (actorId) active.push({ key: "actor", label: `By ${actorName || "one person"}`, clear: { actor: null, actorName: null } });
  if (entityType) active.push({ key: "entityType", label: `Type ${entityType}`, clear: { entityType: null } });
  if (entityId) active.push({ key: "entityId", label: `Item ${entityId}`, clear: { entityId: null } });

  return (
    <AdminPage
      title="Audit log"
      description="Every change to money, keys, the catalogue and settings, and every sign-in, newest first: who did it, to what, and the details recorded."
      filters={
        <div>
          <FilterBar
            tabs={AUDIT_GROUPS.map((g) => ({ value: g.value, label: g.label }))}
            tab={custom ? "all" : group}
            onTabChange={(v) => url.set({ group: v === "all" ? null : v, action: null })}
            tabsLabel="Action"
            search={custom}
            onSearchChange={(v) => url.set({ action: v.trim(), group: null })}
            searchPlaceholder="Action prefix, such as wallet.grant"
            testId="audit-filter"
          >
            <SearchInput value={entityType} onChange={(v) => url.set({ entityType: v.trim() })} placeholder="Entity type" className="sm:w-36" testId="audit-entity-type" />
            <SearchInput value={entityId} onChange={(v) => url.set({ entityId: v.trim() })} placeholder="Entity id" className="sm:w-40" testId="audit-entity-id" />
          </FilterBar>
          {active.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
              {active.map((a) => (
                <button key={a.key} type="button" onClick={() => url.set(a.clear)} className="inline-flex min-w-0 items-center gap-1 break-all text-muted-foreground hover:text-foreground" aria-label={`Clear filter: ${a.label}`}>
                  {a.label} <X className="size-3.5 shrink-0" aria-hidden />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      }
      testId="admin-audit"
    >
      {list.isError && !items.length ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <ul className="divide-y divide-border border-b border-border" aria-busy>
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="flex items-center gap-3 py-3.5">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="ml-auto h-4 w-16" />
            </li>
          ))}
        </ul>
      ) : !items.length ? (
        <EmptyState compact title={active.length || action ? "Nothing matches these filters." : "Nothing recorded yet."} />
      ) : (
        <>
          <ul className="divide-y divide-border border-b border-border" data-testid="audit-list">
            {items.map((e) => (
              <AuditRow key={e.id} entry={e} onActor={(a) => url.set({ actor: a.id, actorName: a.displayName })} onEntity={(t, id) => url.set({ entityType: t, entityId: id })} />
            ))}
          </ul>
          <div className="flex min-h-12 items-center justify-center py-3" aria-live="polite">
            {list.isFetchingNextPage ? (
              <Spinner />
            ) : list.hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()} data-testid="audit-more">
                Load more
              </Button>
            ) : (
              <p className="text-xs text-subtle-foreground">That is the start of the log.</p>
            )}
          </div>
        </>
      )}
    </AdminPage>
  );
}

function AuditRow({ entry: e, onActor, onEntity }: { entry: AuditEntry; onActor: (a: NonNullable<AuditEntry["actor"]>) => void; onEntity: (type: string, id: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasData = Object.keys(e.data ?? {}).length > 0;
  const panel = `audit-${e.id}`;
  return (
    <li data-testid={`audit-row-${e.id}`}>
      <div className="flex items-start gap-3 py-3">
        {e.actor ? (
          <PersonAvatar user={e.actor} size="sm" />
        ) : (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground" aria-hidden>
            SYS
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[14px]">
            {e.actor ? (
              <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onActor(e.actor!)} title="Show only this person's changes">
                {e.actor.displayName}
              </button>
            ) : (
              <span className="font-medium">The system</span>
            )}
            <span className="text-muted-foreground"> · {humanizeAction(e.action)}</span>
          </p>
          <p className="mt-0.5 break-all text-[12.5px] text-muted-foreground">
            <span className="font-mono">{e.action}</span>
            {" · "}
            {e.entityId ? (
              <button type="button" className="break-all text-left font-mono hover:text-foreground hover:underline" onClick={() => onEntity(e.entityType, e.entityId!)} title="Show every change to this item">
                {e.entityType} {e.entityId}
              </button>
            ) : (
              <span className="font-mono">{e.entityType}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <time dateTime={e.createdAt} title={fullTimestamp(e.createdAt)} className="text-[12.5px] tabular-nums text-muted-foreground">
            {relativeTime(e.createdAt)}
          </time>
          {hasData ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panel}
              onClick={() => setOpen((o) => !o)}
              className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={open ? "Hide details" : "Show details"}
              data-testid="audit-expand"
            >
              <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <span className="inline-block size-8" aria-hidden />
          )}
        </div>
      </div>
      {open && hasData ? (
        <pre id={panel} className="mb-3 max-h-80 overflow-auto rounded-md bg-ground-2 p-3 font-mono text-[12.5px] leading-relaxed text-foreground sm:ml-11" data-testid="audit-data">
          {prettyJson(e.data)}
        </pre>
      ) : null}
    </li>
  );
}
