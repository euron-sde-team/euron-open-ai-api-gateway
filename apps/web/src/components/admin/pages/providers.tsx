"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Trash2 } from "lucide-react";
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger, Field, IconButton, Input, Select, Switch, toast,
} from "@open-gateway/ui";
import type { AdminProvider, ProviderKind } from "@open-gateway/types";
import { api } from "@/lib/api";
import { PROVIDER_KIND_LABEL, adminErrorMessage, providerDraftErrors, shortDate, type ProviderDraft } from "@/lib/admin";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { AdminPage, DataTable, DetailSection, DetailSheet, FactList, StatusText, useUrlState, type Column } from "../shell";
import { adminMutation, ak } from "./common";

const PROVIDER_KINDS = Object.keys(PROVIDER_KIND_LABEL) as ProviderKind[];

/** Credentials that can serve traffic (the stub needs none). */
export function providerReady(p: AdminProvider): { ok: boolean; label: string } {
  if (!p.enabled) return { ok: false, label: "Off" };
  if (p.kind === "STUB") return { ok: true, label: "Ready, no credential needed" };
  const on = p.credentials.filter((c) => c.enabled).length;
  if (!on) return { ok: false, label: p.credentials.length ? "No enabled credential" : "No credential" };
  return { ok: true, label: on === 1 ? "1 credential" : `${on} credentials, used in turn` };
}

export function AdminProviders() {
  const qc = useQueryClient();
  const url = useUrlState();
  const open = url.get("open") || null;
  const q = useQuery({ queryKey: ak.providers, queryFn: () => api().admin.providers() });
  const integrations = useQuery({ queryKey: ak.integrations, queryFn: () => api().admin.integrations(), staleTime: 5 * 60_000 });
  const [editing, setEditing] = useState<AdminProvider | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminProvider | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteProvider(id),
    ...adminMutation({ inline: true }),
    onSuccess: (list, id) => {
      qc.setQueryData(ak.providers, list);
      void qc.invalidateQueries({ queryKey: ak.models });
      void qc.invalidateQueries({ queryKey: ak.health });
      if (open === id) url.set({ open: null });
      toast.success({ title: "Provider deleted" });
    },
  });

  const columns = useMemo<Column<AdminProvider>[]>(
    () => [
      {
        key: "name",
        header: "Provider",
        cell: (p) => (
          <div className="min-w-0">
            <p className="font-medium text-foreground">{p.displayName}</p>
            <p className="truncate font-mono text-[12px] text-muted-foreground">{p.id}</p>
          </div>
        ),
        sortValue: (p) => p.displayName,
      },
      { key: "kind", header: "Kind", cell: (p) => <span className="text-muted-foreground">{PROVIDER_KIND_LABEL[p.kind]}</span>, sortValue: (p) => p.kind, hideBelow: "sm" },
      { key: "url", header: "Base URL", cell: (p) => <span className="break-all font-mono text-[12px] text-muted-foreground">{p.baseUrl ?? "Provider default"}</span>, hideBelow: "lg" },
      {
        key: "status",
        header: "Status",
        cell: (p) => {
          const r = providerReady(p);
          return <StatusText tone={!p.enabled ? "muted" : r.ok ? "success" : "warning"}>{r.label}</StatusText>;
        },
      },
      { key: "routes", header: "Routes", align: "right", cell: (p) => p.routeCount, sortValue: (p) => p.routeCount, hideBelow: "sm" },
      {
        key: "menu",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        className: "w-10",
        cell: (p) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Actions for ${p.displayName}`} size="sm" data-testid={`provider-menu-${p.id}`}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => url.set({ open: p.id })}>Credentials</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(p)}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(p)} className="text-danger">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [url],
  );

  const keyMissing = integrations.data && !integrations.data.credentialsKeyConfigured;
  const current = q.data?.find((p) => p.id === open) ?? null;

  return (
    <AdminPage
      title="Providers"
      description="The upstream APIs the gateway calls. Each provider holds one or more credentials, used in turn. Models reach providers through routes on the Models page."
      actions={
        <Button onClick={() => setEditing("new")} data-testid="provider-add">
          Add provider
        </Button>
      }
      testId="admin-providers"
    >
      {keyMissing ? (
        <p role="alert" className="mb-5 border-y border-border py-3 text-[13.5px] text-warning" data-testid="credentials-key-missing">
          CREDENTIALS_KEY is the development default: fine on a laptop, refused in production. Set your own before adding real provider keys; credentials saved under one key cannot be read with another.
        </p>
      ) : null}
      <DataTable
        caption="Providers"
        rows={q.data ?? []}
        columns={columns}
        rowKey={(p) => p.id}
        onRowClick={(p) => url.set({ open: p.id })}
        selectedKey={open}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonRows={3}
        empty={{ title: "No providers yet.", description: "Add one, give it a credential, then route models to it." }}
        rowTestId={(p) => `provider-row-${p.id}`}
        testId="providers-table"
      />
      <ProviderSheet provider={current} loading={!!open && q.isPending} onClose={() => url.set({ open: null })} onEdit={setEditing} />
      <ProviderDialog value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.displayName ?? "provider"}?`}
        description={
          deleting?.routeCount
            ? `Its ${deleting.routeCount} ${deleting.routeCount === 1 ? "route is" : "routes are"} deleted too, and its credentials. If a model would be left without a priced route the API refuses. To stop traffic instead, turn it off.`
            : "It has no routes. Its credentials are deleted with it."
        }
        confirmLabel="Delete provider"
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
    </AdminPage>
  );
}

function ProviderSheet({ provider: p, loading, onClose, onEdit }: { provider: AdminProvider | null; loading: boolean; onClose: () => void; onEdit: (p: AdminProvider) => void }) {
  const open = !!p || loading;
  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={p?.displayName ?? ""}
      description={p ? <span className="font-mono">{p.id}</span> : undefined}
      actions={
        p ? (
          <Button variant="outline" size="sm" onClick={() => onEdit(p)} data-testid="provider-edit">
            Edit provider
          </Button>
        ) : undefined
      }
      loading={loading}
      testId="provider-sheet"
    >
      {p ? (
        <>
          <DetailSection title="Provider">
            <FactList
              items={[
                { label: "Kind", value: PROVIDER_KIND_LABEL[p.kind] },
                { label: "Base URL", value: <span className="break-all font-mono text-[13px]">{p.baseUrl ?? "Provider default"}</span> },
                { label: "Enabled", value: p.enabled ? <StatusText tone="success">On</StatusText> : <StatusText tone="muted">Off</StatusText> },
                { label: "Routes", value: String(p.routeCount) },
              ]}
            />
          </DetailSection>
          <DetailSection title="Credentials">
            <Credentials provider={p} />
          </DetailSection>
        </>
      ) : null}
    </DetailSheet>
  );
}

function Credentials({ provider: p }: { provider: AdminProvider }) {
  const id = useId();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AdminProvider["credentials"][number] | null>(null);
  useEffect(() => {
    setLabel("");
    setSecret("");
    setError(null);
  }, [p.id]);

  const add = useMutation({
    mutationFn: () => api().admin.addCredential(p.id, { label: label.trim(), secret }),
    ...adminMutation({ inline: true }),
    onMutate: () => setError(null),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.providers, list);
      setLabel("");
      setSecret("");
      toast.success({ title: "Credential added" });
    },
  });
  const toggle = useMutation({
    mutationFn: ({ credentialId, enabled }: { credentialId: string; enabled: boolean }) => api().admin.setCredentialEnabled(p.id, credentialId, enabled),
    ...adminMutation(),
    onMutate: ({ credentialId, enabled }) => {
      // Instant: flip the switch while the request runs.
      const prev = qc.getQueryData<AdminProvider[]>(ak.providers);
      if (prev) qc.setQueryData<AdminProvider[]>(ak.providers, prev.map((x) => (x.id === p.id ? { ...x, credentials: x.credentials.map((c) => (c.id === credentialId ? { ...c, enabled } : c)) } : x)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ak.providers, ctx.prev);
      toast.error({ title: adminErrorMessage(e) });
    },
    onSuccess: (list) => qc.setQueryData(ak.providers, list),
  });
  const del = useMutation({
    mutationFn: (credentialId: string) => api().admin.deleteCredential(p.id, credentialId),
    ...adminMutation({ inline: true }),
    onSuccess: (list) => {
      qc.setQueryData(ak.providers, list);
      toast.success({ title: "Credential deleted" });
    },
  });

  const labelOk = label.trim().length >= 1 && label.trim().length <= 60;
  const secretOk = secret.length >= 8 && secret.length <= 4000;

  return (
    <div>
      {p.kind === "STUB" ? <p className="mb-3 text-[13px] text-muted-foreground">The local stub answers without calling anyone, so it needs no credential.</p> : null}
      {p.credentials.length ? (
        <ul className="border-y border-border" aria-label={`Credentials for ${p.displayName}`} data-testid="credentials-list">
          {p.credentials.map((c) => (
            <li key={c.id} className="flex items-center gap-3 border-b border-border py-3 last:border-b-0" data-testid={`credential-${c.id}`}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-foreground">{c.label}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Ends in <span className="font-mono">{c.last4}</span> · added {shortDate(c.createdAt)}
                </p>
                {!c.enabled && c.disabledReason ? <p className="mt-0.5 text-[12.5px] text-warning">{c.disabledReason}</p> : null}
              </div>
              <Switch
                checked={c.enabled}
                onCheckedChange={(v) => toggle.mutate({ credentialId: c.id, enabled: v })}
                aria-label={`${c.enabled ? "Turn off" : "Turn on"} ${c.label}`}
                data-testid={`credential-enabled-${c.id}`}
              />
              <IconButton label={`Delete ${c.label}`} size="sm" onClick={() => setDeleting(c)} data-testid={`credential-delete-${c.id}`}>
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : p.kind !== "STUB" ? (
        <p className="text-[13.5px] text-warning">No credentials yet. Routes to this provider cannot serve traffic until one is added and enabled.</p>
      ) : null}

      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (labelOk && secretOk) add.mutate();
        }}
        data-testid="credential-form"
      >
        <h4 className="text-[13px] font-semibold text-foreground">Add a credential</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" htmlFor={`${id}-label`} hint="So you can tell keys apart, such as Production key 2.">
            <Input id={`${id}-label`} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} autoComplete="off" data-testid="credential-label" />
          </Field>
          <Field label="Secret" htmlFor={`${id}-secret`} hint="Encrypted on arrival. It is never shown again." error={secret && !secretOk ? "At least 8 characters." : undefined}>
            <Input id={`${id}-secret`} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} data-testid="credential-secret" />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="text-[13px] font-medium text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!labelOk || !secretOk} loading={add.isPending} data-testid="credential-add">
            Add credential
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.label ?? "credential"}?`}
        description="The encrypted secret is deleted. Requests use the provider's other enabled credentials, if any."
        confirmLabel="Delete credential"
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
    </div>
  );
}

const BLANK: ProviderDraft = { id: "", kind: "OPENAI_COMPATIBLE", displayName: "", baseUrl: "", enabled: true };

function ProviderDialog({ value, onClose }: { value: AdminProvider | "new" | null; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const isNew = value === "new";
  const existing = value && value !== "new" ? value : null;
  const [f, setF] = useState<ProviderDraft>(BLANK);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setF(existing ? { id: existing.id, kind: existing.kind, displayName: existing.displayName, baseUrl: existing.baseUrl ?? "", enabled: existing.enabled } : BLANK);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = providerDraftErrors(f, isNew);
  const ok = Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body = { kind: f.kind, displayName: f.displayName.trim(), baseUrl: f.baseUrl.trim() || null, enabled: f.enabled };
      return isNew ? api().admin.createProvider({ id: f.id, ...body }) : api().admin.updateProvider(existing!.id, body);
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.providers, list);
      void qc.invalidateQueries({ queryKey: ak.models });
      toast.success({ title: isNew ? "Provider added" : "Provider saved" });
      onClose();
    },
  });
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="provider-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? "Add a provider" : `Edit ${existing?.displayName ?? "provider"}`}</DialogTitle>
            <DialogDescription>Add its credentials after saving, from the provider&apos;s panel.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Slug" htmlFor={`${id}-slug`} hint={isNew ? "Lowercase letters, digits and hyphens, such as openai or groq. It cannot change later." : "The slug cannot change."} error={isNew && f.id ? errs.id : undefined}>
              <Input id={`${id}-slug`} value={f.id} onChange={(e) => setF((x) => ({ ...x, id: e.target.value.toLowerCase() }))} disabled={!isNew} autoComplete="off" className="font-mono" data-testid="provider-slug" />
            </Field>
            <Field label="Kind" htmlFor={`${id}-kind`} hint="The wire protocol the gateway speaks to it.">
              <Select id={`${id}-kind`} value={f.kind} onValueChange={(v) => setF((x) => ({ ...x, kind: v as ProviderKind }))} options={PROVIDER_KINDS.map((k) => ({ value: k, label: PROVIDER_KIND_LABEL[k] }))} data-testid="provider-kind" />
            </Field>
            <Field label="Display name" htmlFor={`${id}-name`} error={f.displayName ? errs.displayName : undefined}>
              <Input id={`${id}-name`} value={f.displayName} maxLength={60} onChange={(e) => setF((x) => ({ ...x, displayName: e.target.value }))} data-testid="provider-name" />
            </Field>
            <Field
              label="Base URL"
              htmlFor={`${id}-url`}
              optional={f.kind !== "OPENAI_COMPATIBLE"}
              hint={f.kind === "OPENAI_COMPATIBLE" ? "Required: the OpenAI style endpoint, such as https://api.example.com/v1." : "Leave empty to use the provider's own endpoint."}
              error={f.baseUrl ? errs.baseUrl : undefined}
            >
              <Input id={`${id}-url`} value={f.baseUrl} maxLength={300} onChange={(e) => setF((x) => ({ ...x, baseUrl: e.target.value }))} className="font-mono" placeholder="https://api.example.com/v1" data-testid="provider-url" />
            </Field>
            <label className="flex items-center justify-between gap-4 text-[14px]">
              <span>
                <span className="font-medium">Enabled</span>
                <span className="block text-[13px] text-muted-foreground">Turned off, its routes are skipped and requests fail over.</span>
              </span>
              <Switch checked={f.enabled} onCheckedChange={(v) => setF((x) => ({ ...x, enabled: v }))} data-testid="provider-enabled" />
            </label>
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
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="provider-save">
              {isNew ? "Add provider" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
