"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { isApiError } from "@open-gateway/api-client";
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, Field, IconButton, Input, Select, Switch, Textarea, toast,
} from "@open-gateway/ui";
import type { AdminModel, AdminProvider, ModelKind, ModelRoute, ModelTestResult } from "@open-gateway/types";
import { api } from "@/lib/api";
import {
  CIRCUIT_HINT, CIRCUIT_LABEL, CIRCUIT_TONE, KIND_COSTS, MODEL_KINDS, MODEL_KIND_LABEL, adminErrorMessage, formatCount, isUnpriced, modelDraftBody, modelDraftErrors, modelToDraft,
  priceLine, routeDraftBody, routeDraftErrors, routePriced, routeToDraft, sortModels, unpricedMessage, type ModelDraft, type RouteDraft,
} from "@/lib/admin";
import { bpsLabel, msLabel, tokensLabel } from "@/lib/money";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { TimeAgo } from "@/components/common/time-ago";
import { AdminPage, DataTable, DetailSection, DetailSheet, FactList, FilterBar, StatusText, useUrlState, type Column } from "../shell";
import { adminMutation, ak } from "./common";

type KindTab = "all" | ModelKind;
const KIND_TABS: { value: KindTab; label: string }[] = [{ value: "all", label: "All" }, ...MODEL_KINDS.map((k) => ({ value: k.kind as KindTab, label: k.label }))];
const isKind = (v: string): v is ModelKind => MODEL_KINDS.some((k) => k.kind === v);

/** A blocked change and why: shown in one dialog wherever the API answers MODEL_UNPRICED. */
type Blocked = { modelId: string; title: string; message: string } | null;

/** The other fields of a model as they are, with only `enabled` changed (PUT replaces the model). */
const withEnabled = (m: AdminModel, enabled: boolean) => modelDraftBody({ ...modelToDraft(m), enabled });

export function AdminModels() {
  const qc = useQueryClient();
  const url = useUrlState();
  const kindParam = url.get("kind");
  const kind: KindTab = isKind(kindParam) ? kindParam : "all";
  const search = url.get("q");
  const open = url.get("open") || null;
  const q = useQuery({ queryKey: ak.models, queryFn: () => api().admin.models() });
  const providers = useQuery({ queryKey: ak.providers, queryFn: () => api().admin.providers(), staleTime: 60_000 });
  const [modelDialog, setModelDialog] = useState<AdminModel | { kind: ModelKind } | null>(null);
  const [deleting, setDeleting] = useState<AdminModel | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortModels(q.data ?? []).filter((m) => (kind === "all" || m.kind === kind) && (!term || m.id.toLowerCase().includes(term) || m.displayName.toLowerCase().includes(term) || m.aliases.some((a) => a.toLowerCase().includes(term))));
  }, [q.data, kind, search]);

  const toggle = useMutation({
    mutationFn: ({ m, enabled }: { m: AdminModel; enabled: boolean }) => api().admin.updateModel(m.id, withEnabled(m, enabled)),
    meta: { silent: true },
    onMutate: ({ m, enabled }) => {
      const prev = qc.getQueryData<AdminModel[]>(ak.models);
      if (prev) qc.setQueryData<AdminModel[]>(ak.models, prev.map((x) => (x.id === m.id ? { ...x, enabled } : x)));
      return { prev };
    },
    onError: (e, { m }, ctx) => {
      if (ctx?.prev) qc.setQueryData(ak.models, ctx.prev);
      if (isUnpriced(e)) setBlocked({ modelId: m.id, title: `${m.displayName} cannot be turned on yet`, message: unpricedMessage(isApiError(e) ? e.details : null) });
      else toast.error({ title: adminErrorMessage(e) });
    },
    onSuccess: (list) => qc.setQueryData(ak.models, list),
  });
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteModel(id),
    ...adminMutation({ inline: true }),
    onSuccess: (list, id) => {
      qc.setQueryData(ak.models, list);
      void qc.invalidateQueries({ queryKey: ak.providers });
      void qc.invalidateQueries({ queryKey: ak.health });
      if (open === id) url.set({ open: null });
      toast.success({ title: "Model deleted" });
    },
  });

  const columns = useMemo<Column<AdminModel>[]>(
    () => [
      {
        key: "model",
        header: "Model",
        cell: (m) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{m.displayName}</p>
            <p className="truncate font-mono text-[12px] text-muted-foreground">
              {m.id}
              {m.aliases.length ? <span className="font-sans"> · also {m.aliases.join(", ")}</span> : null}
            </p>
          </div>
        ),
        sortValue: (m) => m.displayName,
        className: "max-w-[280px] sm:max-w-none",
      },
      { key: "kind", header: "Kind", cell: (m) => <span className="text-muted-foreground">{MODEL_KIND_LABEL[m.kind]}</span>, sortValue: (m) => m.kind, hideBelow: "md" },
      { key: "price", header: "Price callers pay", cell: (m) => <span className={m.price ? "text-foreground" : "text-warning"}>{priceLine(m.kind, m.price)}</span>, hideBelow: "sm" },
      {
        key: "margin",
        header: "Margin",
        align: "right",
        cell: (m) => (
          <span title={m.marginBps === null ? "The default margin" : "This model's own margin"}>
            {bpsLabel(m.effectiveMarginBps, true)}
            {m.marginBps === null ? <span className="block text-[12px] text-subtle-foreground">default</span> : null}
          </span>
        ),
        sortValue: (m) => m.effectiveMarginBps,
        hideBelow: "lg",
      },
      {
        key: "routes",
        header: "Routes",
        align: "right",
        cell: (m) => {
          const on = m.routes.filter((r) => r.enabled);
          const open = on.filter((r) => r.circuit !== "closed").length;
          return (
            <span>
              {on.length} of {m.routes.length}
              {open ? <span className="block text-[12px] text-warning">{open} tripped</span> : null}
            </span>
          );
        },
        sortValue: (m) => m.routes.length,
        hideBelow: "md",
      },
      { key: "context", header: "Context", align: "right", cell: (m) => (m.contextWindow ? tokensLabel(m.contextWindow) : <span className="text-subtle-foreground">None</span>), sortValue: (m) => m.contextWindow, hideBelow: "lg" },
      { key: "sort", header: "Order", align: "right", cell: (m) => m.sortOrder, sortValue: (m) => m.sortOrder, hideBelow: "lg" },
      {
        key: "enabled",
        header: "Enabled",
        align: "right",
        cell: (m) => <Switch checked={m.enabled} onCheckedChange={(v) => toggle.mutate({ m, enabled: v })} aria-label={`${m.enabled ? "Turn off" : "Turn on"} ${m.displayName}`} data-testid={`model-enabled-${m.id}`} />,
      },
      {
        key: "menu",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        className: "w-10",
        cell: (m) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Actions for ${m.displayName}`} size="sm" data-testid={`model-menu-${m.id}`}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => url.set({ open: m.id })}>Routes</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setModelDialog(m)}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(m)} className="text-danger">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [url, toggle],
  );

  const current = q.data?.find((m) => m.id === open) ?? null;
  const filtered = kind !== "all" || !!search;

  return (
    <AdminPage
      title="Models"
      description="The catalogue developers call. Each model reaches providers through routes, tried in priority order. The price is the first enabled route's cost plus the margin in force: key, then account, then model, then the default."
      actions={
        <Button onClick={() => setModelDialog({ kind: kind === "all" ? "CHAT" : kind })} data-testid="model-add">
          Add model
        </Button>
      }
      filters={
        <FilterBar
          tabs={KIND_TABS}
          tab={kind}
          onTabChange={(v) => url.set({ kind: v === "all" ? null : v })}
          tabsLabel="Kind"
          search={search}
          onSearchChange={(v) => url.set({ q: v.trim() })}
          searchPlaceholder="Search id, name or alias"
          testId="models-filter"
        />
      }
      testId="admin-models"
    >
      <DataTable
        caption="Models"
        rows={rows}
        columns={columns}
        rowKey={(m) => m.id}
        onRowClick={(m) => url.set({ open: m.id })}
        selectedKey={open}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonRows={5}
        empty={{ title: filtered ? "No models match." : "No models yet.", description: filtered ? undefined : "Add a provider first, then a model with a route to it." }}
        rowTestId={(m) => `model-row-${m.id}`}
        testId="models-table"
      />
      <ModelSheet
        model={current}
        loading={!!open && q.isPending}
        providers={providers.data ?? []}
        onClose={() => url.set({ open: null })}
        onEdit={setModelDialog}
        onDelete={setDeleting}
        onBlocked={setBlocked}
        onToggle={(m, enabled) => toggle.mutate({ m, enabled })}
      />
      <ModelDialog value={modelDialog} onClose={() => setModelDialog(null)} onCreated={(id) => url.set({ open: id })} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.displayName ?? "model"}?`}
        description="Developers calling it get model not found. Its routes go with it; request history keeps the model id. To stop traffic but keep the setup, turn it off."
        confirmLabel="Delete model"
        destructive
        onConfirm={async () => {
          try {
            await del.mutateAsync(deleting!.id);
          } catch (e) {
            toast.error({ title: adminErrorMessage(e) });
            throw e;
          }
        }}
      />
      <Dialog open={!!blocked} onOpenChange={(o) => !o && setBlocked(null)}>
        <DialogContent size="sm" data-testid="model-unpriced-dialog">
          <DialogHeader>
            <DialogTitle>{blocked?.title}</DialogTitle>
            <DialogDescription>{blocked?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBlocked(null)}>
              Close
            </Button>
            {blocked && blocked.modelId !== open ? (
              <Button
                onClick={() => {
                  url.set({ open: blocked.modelId });
                  setBlocked(null);
                }}
              >
                Open its routes
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}

// ─── Model detail ───────────────────────────────────────────────────────────

function ModelSheet({
  model: m, loading, providers, onClose, onEdit, onDelete, onBlocked, onToggle,
}: {
  model: AdminModel | null;
  loading: boolean;
  providers: AdminProvider[];
  onClose: () => void;
  onEdit: (m: AdminModel) => void;
  onDelete: (m: AdminModel) => void;
  onBlocked: (b: Blocked) => void;
  onToggle: (m: AdminModel, enabled: boolean) => void;
}) {
  const qc = useQueryClient();
  const [routeDialog, setRouteDialog] = useState<ModelRoute | "new" | null>(null);
  const [deletingRoute, setDeletingRoute] = useState<ModelRoute | null>(null);
  const [tests, setTests] = useState<Record<string, { pending: boolean; result?: ModelTestResult; error?: string }>>({});
  useEffect(() => setTests({}), [m?.id]);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id;
  const delRoute = useMutation({
    mutationFn: (r: ModelRoute) => api().admin.deleteRoute(m!.id, r.id),
    meta: { silent: true },
    onSuccess: (list) => {
      qc.setQueryData(ak.models, list);
      void qc.invalidateQueries({ queryKey: ak.providers });
      void qc.invalidateQueries({ queryKey: ak.health });
      toast.success({ title: "Route deleted" });
    },
  });
  const runTest = async (r: ModelRoute) => {
    setTests((t) => ({ ...t, [r.id]: { pending: true } }));
    try {
      const result = await api().admin.testRoute(m!.id, r.id);
      setTests((t) => ({ ...t, [r.id]: { pending: false, result } }));
      void qc.invalidateQueries({ queryKey: ak.models });
    } catch (e) {
      setTests((t) => ({ ...t, [r.id]: { pending: false, error: adminErrorMessage(e) } }));
    }
  };

  const routes = m ? [...m.routes].sort((a, b) => a.priority - b.priority) : [];
  const primary = routes.find((r) => r.enabled);
  const priced = !!m && routes.some((r) => r.enabled && routePriced(m.kind, r));

  return (
    <DetailSheet
      open={!!m || loading}
      onOpenChange={(o) => !o && onClose()}
      title={m?.displayName ?? ""}
      description={m ? <span className="font-mono">{m.id}</span> : undefined}
      width="max-w-2xl"
      loading={loading}
      actions={
        m ? (
          <>
            <Button variant="outline" size="sm" onClick={() => onEdit(m)} data-testid="model-edit">
              Edit model
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRouteDialog("new")} data-testid="route-add">
              Add route
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={() => onDelete(m)} data-testid="model-delete">
              Delete
            </Button>
          </>
        ) : undefined
      }
      testId="model-sheet"
    >
      {m ? (
        <>
          <DetailSection
            title="Availability"
            action={<Switch checked={m.enabled} onCheckedChange={(v) => onToggle(m, v)} aria-label={`${m.enabled ? "Turn off" : "Turn on"} ${m.displayName}`} data-testid="model-sheet-enabled" />}
          >
            {m.enabled ? (
              <StatusText tone="success">Enabled: developers can call it</StatusText>
            ) : priced ? (
              <StatusText tone="muted">Off: hidden from the catalogue</StatusText>
            ) : (
              <p className="text-[13.5px] text-warning" data-testid="model-unpriced-note">
                Off, and it cannot be turned on yet: it needs an enabled route with a cost above zero, on an enabled provider with an enabled credential.
              </p>
            )}
          </DetailSection>

          <DetailSection title="Price">
            <FactList
              items={[
                { label: "Callers pay", value: <span data-testid="model-price">{priceLine(m.kind, m.price)}</span> },
                { label: "Route cost", value: primary ? `${priceLine(m.kind, primary)} via ${providerName(primary.providerId)}` : "No enabled route" },
                { label: "Margin in force", value: `${bpsLabel(m.effectiveMarginBps, true)}${m.marginBps === null ? ", the default" : ", this model's own"}` },
              ]}
            />
            <p className="mt-3 text-[12.5px] text-muted-foreground">Keys and accounts with their own margin pay a different price. Set those on the Users page.</p>
          </DetailSection>

          <DetailSection title={`Routes (${routes.length})`}>
            {routes.length ? (
              <ol className="border-y border-border" aria-label={`Routes for ${m.displayName}`} data-testid="routes-list">
                {routes.map((r) => (
                  <RouteItem
                    key={r.id}
                    route={r}
                    kind={m.kind}
                    provider={providerName(r.providerId)}
                    test={tests[r.id]}
                    onTest={() => void runTest(r)}
                    onEdit={() => setRouteDialog(r)}
                    onDelete={() => setDeletingRoute(r)}
                  />
                ))}
              </ol>
            ) : (
              <p className="text-[13.5px] text-muted-foreground">No routes yet. Add one to say which provider serves this model and what it costs.</p>
            )}
          </DetailSection>

          <DetailSection title="Details">
            <FactList
              items={[
                { label: "Kind", value: MODEL_KIND_LABEL[m.kind] },
                { label: "Aliases", value: m.aliases.length ? <span className="font-mono text-[13px]">{m.aliases.join(", ")}</span> : "None" },
                { label: "Owned by", value: m.ownedBy || "Not set" },
                { label: "Description", value: m.description || "None" },
                { label: "Context window", value: m.contextWindow ? `${formatCount(m.contextWindow)} tokens` : "Not set" },
                { label: "Max output", value: m.maxOutputTokens ? `${formatCount(m.maxOutputTokens)} tokens` : "Not set" },
                ...(m.kind === "CHAT" ? [{ label: "Supports", value: capabilities(m) }] : []),
                { label: "Sort order", value: String(m.sortOrder) },
              ]}
            />
          </DetailSection>

          <RouteDialog
            value={routeDialog}
            model={m}
            providers={providers}
            onClose={() => setRouteDialog(null)}
            onBlocked={(message) => onBlocked({ modelId: m.id, title: "That change would leave the model unbillable", message })}
          />
          <ConfirmDialog
            open={!!deletingRoute}
            onOpenChange={(o) => !o && setDeletingRoute(null)}
            title="Delete this route?"
            description={deletingRoute ? `${providerName(deletingRoute.providerId)} stops serving ${m.displayName}. Requests use the remaining routes.` : undefined}
            confirmLabel="Delete route"
            destructive
            onConfirm={async () => {
              try {
                await delRoute.mutateAsync(deletingRoute!);
              } catch (e) {
                setDeletingRoute(null);
                if (isUnpriced(e)) onBlocked({ modelId: m.id, title: "This is the model's last priced route", message: unpricedMessage(isApiError(e) ? e.details : null) });
                else toast.error({ title: adminErrorMessage(e) });
              }
            }}
          />
        </>
      ) : null}
    </DetailSheet>
  );
}

const capabilities = (m: AdminModel) => {
  const c = [m.supportsTools && "Tools", m.supportsVision && "Vision", m.supportsJson && "JSON mode"].filter(Boolean);
  return c.length ? c.join(", ") : "Text only";
};

function RouteItem({
  route: r, kind, provider, test, onTest, onEdit, onDelete,
}: {
  route: ModelRoute;
  kind: ModelKind;
  provider: string;
  test?: { pending: boolean; result?: ModelTestResult; error?: string };
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const priced = routePriced(kind, r);
  return (
    <li className="border-b border-border py-3.5 last:border-b-0" data-testid={`route-${r.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-[14px] text-foreground">
            <span className="mr-2 tabular-nums text-muted-foreground" title="Priority: lower is tried first">
              {r.priority}.
            </span>
            <span className="font-medium">{provider}</span>
            <span className="text-muted-foreground"> serves </span>
            <span className="break-all font-mono text-[13px]">{r.upstreamModel}</span>
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {priced ? priceLine(kind, r) : <span className="text-warning">No cost set: cannot bill</span>} · times out after {msLabel(r.timeoutMs)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {r.enabled ? <StatusText tone="success">Enabled</StatusText> : <StatusText tone="muted">Off</StatusText>}
            <span title={CIRCUIT_HINT[r.circuit]}>
              <StatusText tone={CIRCUIT_TONE[r.circuit]} testId={`route-circuit-${r.id}`}>
                Circuit {CIRCUIT_LABEL[r.circuit].toLowerCase()}
              </StatusText>
            </span>
            {r.lastCheck ? (
              <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground">
                Last check {r.lastCheck.ok ? "passed" : "failed"}
                {r.lastCheck.latencyMs !== null ? ` in ${msLabel(r.lastCheck.latencyMs)}` : ""}, <TimeAgo value={r.lastCheck.checkedAt} />
              </span>
            ) : (
              <span className="text-[13px] text-subtle-foreground">Not checked yet</span>
            )}
          </div>
          {r.lastCheck && !r.lastCheck.ok && r.lastCheck.error ? <p className="mt-1 break-words text-[12.5px] text-danger">{r.lastCheck.error}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onTest} loading={test?.pending} data-testid={`route-test-${r.id}`}>
            Test
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit the ${provider} route`} data-testid={`route-edit-${r.id}`}>
            Edit
          </Button>
          <Button variant="danger-ghost" size="sm" onClick={onDelete} aria-label={`Delete the ${provider} route`} data-testid={`route-delete-${r.id}`}>
            Delete
          </Button>
        </div>
      </div>
      <div aria-live="polite">
        {test && !test.pending ? (
          <div className="mt-2 text-[13px]" data-testid={`route-test-result-${r.id}`}>
            {test.result ? (
              <p>
                <StatusText tone={test.result.ok ? "success" : "danger"} className="font-medium">
                  {test.result.ok ? "Working" : "Failed"}
                </StatusText>
                <span className="text-muted-foreground"> in {msLabel(test.result.latencyMs)}. </span>
                <span className="break-words text-foreground">{test.result.message}</span>
              </p>
            ) : (
              <p role="alert" className="text-danger">
                {test.error}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ─── Model dialog ───────────────────────────────────────────────────────────

function ModelDialog({ value, onClose, onCreated }: { value: AdminModel | { kind: ModelKind } | null; onClose: () => void; onCreated: (id: string) => void }) {
  const id = useId();
  const qc = useQueryClient();
  const existing = value && "id" in value ? value : null;
  const [d, setD] = useState<ModelDraft>(() => modelToDraft(null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setD(existing ? modelToDraft(existing) : modelToDraft(null, value.kind));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = modelDraftErrors(d, !existing);
  const ok = Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body = modelDraftBody(d);
      return existing ? api().admin.updateModel(existing.id, body) : api().admin.createModel({ id: d.id.trim(), ...body });
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.models, list);
      toast.success({ title: existing ? "Model saved" : "Model added" });
      if (!existing) onCreated(d.id.trim());
      onClose();
    },
  });
  const set = <K extends keyof ModelDraft>(k: K, v: ModelDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const chat = d.kind === "CHAT";
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="lg" data-testid="model-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.displayName}` : "Add a model"}</DialogTitle>
            {!existing ? <DialogDescription>Save it turned off, add a priced route, then turn it on.</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Model id" htmlFor={`${id}-id`} hint={existing ? "The id cannot change." : "What developers send as model, such as gpt-4o-mini."} error={!existing && d.id ? errs.id : undefined}>
                <Input id={`${id}-id`} value={d.id} maxLength={120} onChange={(e) => set("id", e.target.value)} disabled={!!existing} className="font-mono" autoComplete="off" data-testid="model-id" />
              </Field>
              <Field label="Kind" htmlFor={`${id}-kind`} hint={existing ? "The kind cannot change." : "Decides the endpoint and what routes cost."}>
                <Select id={`${id}-kind`} value={d.kind} onValueChange={(v) => set("kind", v as ModelKind)} disabled={!!existing} options={MODEL_KINDS.map((k) => ({ value: k.kind, label: k.label }))} data-testid="model-kind" />
              </Field>
              <Field label="Display name" htmlFor={`${id}-name`} error={d.displayName ? errs.displayName : undefined}>
                <Input id={`${id}-name`} value={d.displayName} maxLength={80} onChange={(e) => set("displayName", e.target.value)} data-testid="model-name" />
              </Field>
              <Field label="Owned by" htmlFor={`${id}-owner`} optional error={errs.ownedBy} hint="Shown in GET /v1/models, such as openai.">
                <Input id={`${id}-owner`} value={d.ownedBy} maxLength={60} onChange={(e) => set("ownedBy", e.target.value)} data-testid="model-owner" />
              </Field>
            </div>
            <Field label="Description" htmlFor={`${id}-desc`} optional error={errs.description}>
              <Textarea id={`${id}-desc`} rows={2} maxLength={300} value={d.description} onChange={(e) => set("description", e.target.value)} data-testid="model-description" />
            </Field>
            <Field label="Aliases" htmlFor={`${id}-aliases`} optional error={errs.aliases} hint="Other names that resolve to this model, separated by commas.">
              <Input id={`${id}-aliases`} value={d.aliases} onChange={(e) => set("aliases", e.target.value)} className="font-mono" autoComplete="off" placeholder="gpt-4o-mini-latest" data-testid="model-aliases" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Context window" htmlFor={`${id}-ctx`} optional error={errs.contextWindow} hint="Tokens.">
                <Input id={`${id}-ctx`} inputMode="numeric" value={d.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} data-testid="model-context" />
              </Field>
              <Field label="Max output" htmlFor={`${id}-out`} optional error={errs.maxOutputTokens} hint="Tokens.">
                <Input id={`${id}-out`} inputMode="numeric" value={d.maxOutputTokens} onChange={(e) => set("maxOutputTokens", e.target.value)} data-testid="model-max-output" />
              </Field>
              <Field label="Sort order" htmlFor={`${id}-sort`} error={errs.sortOrder} hint="Lower comes first.">
                <Input id={`${id}-sort`} inputMode="numeric" value={d.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} data-testid="model-sort" />
              </Field>
            </div>
            <Field label="Margin" htmlFor={`${id}-margin`} optional error={errs.margin} hint="Percent on top of the route cost. Empty uses the default margin. 0 sells at cost.">
              <div className="relative w-40">
                <Input id={`${id}-margin`} inputMode="decimal" placeholder="Default" value={d.margin} onChange={(e) => set("margin", e.target.value)} className="pr-8" data-testid="model-margin" />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-subtle-foreground" aria-hidden>
                  %
                </span>
              </div>
            </Field>
            <div className="space-y-3 border-t border-border pt-4">
              {chat ? (
                <>
                  <SwitchLine label="Tools" hint="Accepts tools and tool_choice." checked={d.supportsTools} onChange={(v) => set("supportsTools", v)} testId="model-tools" />
                  <SwitchLine label="Vision" hint="Accepts image inputs." checked={d.supportsVision} onChange={(v) => set("supportsVision", v)} testId="model-vision" />
                  <SwitchLine label="JSON mode" hint="Accepts response_format." checked={d.supportsJson} onChange={(v) => set("supportsJson", v)} testId="model-json" />
                </>
              ) : null}
              <SwitchLine
                label="Enabled"
                hint={existing ? "Developers can call it. Needs an enabled, priced route." : "Leave off until it has a priced route; the API refuses otherwise."}
                checked={d.enabled}
                onChange={(v) => set("enabled", v)}
                testId="model-enabled"
              />
            </div>
            {error ? (
              <p role="alert" className="text-[13px] font-medium text-danger">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="model-save">
              {existing ? "Save" : "Add model"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SwitchLine({ label, hint, checked, onChange, testId, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; testId: string; disabled?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-4 text-[14px]">
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-[13px] text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={testId} />
    </label>
  );
}

// ─── Route dialog ───────────────────────────────────────────────────────────

function RouteDialog({
  value, model, providers, onClose, onBlocked,
}: {
  value: ModelRoute | "new" | null;
  model: AdminModel;
  providers: AdminProvider[];
  onClose: () => void;
  onBlocked: (message: string) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const existing = value && value !== "new" ? value : null;
  const nextPriority = Math.min(100, Math.max(0, ...model.routes.map((r) => r.priority)) + 1);
  const [d, setD] = useState<RouteDraft>(() => routeToDraft(null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setD(existing ? routeToDraft(existing) : routeToDraft(null, nextPriority, providers[0]?.id ?? ""));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = routeDraftErrors(d, model.kind);
  const ok = Object.keys(errs).length === 0;
  const body = ok ? routeDraftBody(d, model.kind) : null;
  const unpricedDraft = !!body && !routePriced(model.kind, body);
  const save = useMutation({
    mutationFn: () => (existing ? api().admin.updateRoute(model.id, existing.id, body!) : api().admin.addRoute(model.id, body!)),
    ...adminMutation({ inline: true }),
    onError: (e) => {
      if (isUnpriced(e)) {
        onClose();
        onBlocked(unpricedMessage(isApiError(e) ? e.details : null));
      } else setError(adminErrorMessage(e));
    },
    onSuccess: (list) => {
      qc.setQueryData(ak.models, list);
      void qc.invalidateQueries({ queryKey: ak.providers });
      void qc.invalidateQueries({ queryKey: ak.health });
      toast.success({ title: existing ? "Route saved" : "Route added" });
      onClose();
    },
  });
  const set = <K extends keyof RouteDraft>(k: K, v: RouteDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const providerOptions = providers.map((p) => ({ value: p.id, label: p.enabled ? p.displayName : `${p.displayName} (off)` }));
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="route-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? "Edit route" : "Add a route"}</DialogTitle>
            <DialogDescription>
              How {model.displayName} reaches a provider and what each call costs the platform. Costs are in US dollars.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider" htmlFor={`${id}-p`} error={errs.providerId && providers.length ? errs.providerId : undefined} hint={providers.length ? undefined : "Add a provider on the Providers page first."}>
                <Select id={`${id}-p`} value={d.providerId || undefined} placeholder="Pick a provider" onValueChange={(v) => set("providerId", v)} options={providerOptions} data-testid="route-provider" />
              </Field>
              <Field label="Upstream model" htmlFor={`${id}-u`} hint="The id the provider expects." error={d.upstreamModel ? errs.upstreamModel : undefined}>
                <Input id={`${id}-u`} value={d.upstreamModel} maxLength={160} onChange={(e) => set("upstreamModel", e.target.value)} className="font-mono" autoComplete="off" data-testid="route-upstream" />
              </Field>
              <Field label="Priority" htmlFor={`${id}-prio`} error={errs.priority} hint="1 to 100. Lower is tried first.">
                <Input id={`${id}-prio`} inputMode="numeric" value={d.priority} onChange={(e) => set("priority", e.target.value)} data-testid="route-priority" />
              </Field>
              <Field label="Timeout, seconds" htmlFor={`${id}-t`} error={errs.timeout} hint="Then it fails over to the next route.">
                <Input id={`${id}-t`} inputMode="decimal" value={d.timeout} onChange={(e) => set("timeout", e.target.value)} data-testid="route-timeout" />
              </Field>
            </div>
            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
              {KIND_COSTS[model.kind].map((c) => (
                <Field key={c.field} label={c.label} htmlFor={`${id}-${c.field}`} optional={c.field === "cached"} error={errs[c.field]}>
                  <Input id={`${id}-${c.field}`} inputMode="decimal" placeholder={c.field === "cached" ? "Same as input" : "0.00"} value={d[c.field]} onChange={(e) => set(c.field, e.target.value)} data-testid={`route-cost-${c.field}`} />
                </Field>
              ))}
            </div>
            {unpricedDraft ? <p className="text-[13px] text-warning">With no cost above zero this route cannot bill, so it cannot be what keeps an enabled model on.</p> : null}
            <SwitchLine label="Enabled" hint="Turned off, requests skip it." checked={d.enabled} onChange={(v) => set("enabled", v)} testId="route-enabled" />
            {error ? (
              <p role="alert" className="text-[13px] font-medium text-danger">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="route-save">
              {existing ? "Save" : "Add route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
