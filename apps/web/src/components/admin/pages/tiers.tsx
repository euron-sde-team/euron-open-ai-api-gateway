"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TierInput } from "@open-gateway/api-client";
import { MoreHorizontal } from "lucide-react";
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger, Field, IconButton, Input, Switch, toast,
} from "@open-gateway/ui";
import type { LimitTier } from "@open-gateway/types";
import { api } from "@/lib/api";
import { adminErrorMessage, formatCount, limitLabel, limitText, parseLimit, tierDraftErrors, type TierDraft } from "@/lib/admin";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { AdminPage, DataTable, Dot, type Column } from "../shell";
import { adminMutation, ak } from "./common";

const unlimitedLast = (v: number | null) => v ?? Number.MAX_SAFE_INTEGER;

export function AdminTiers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.tiers, queryFn: () => api().admin.tiers() });
  const [editing, setEditing] = useState<LimitTier | "new" | null>(null);
  const [deleting, setDeleting] = useState<LimitTier | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api().admin.deleteTier(id),
    ...adminMutation({ inline: true }),
    onSuccess: (list) => {
      qc.setQueryData(ak.tiers, list);
      void qc.invalidateQueries({ queryKey: ak.usersPrefix });
      toast.success({ title: "Tier deleted" });
    },
  });
  const columns = useMemo<Column<LimitTier>[]>(
    () => [
      {
        key: "name",
        header: "Tier",
        cell: (t) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-medium text-foreground">{t.name}</span>
            {t.isDefault ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground" data-testid="tier-default-marker">
                <Dot tone="primary" /> Default
              </span>
            ) : null}
          </span>
        ),
        sortValue: (t) => t.name,
      },
      { key: "rpm", header: "Requests a minute", align: "right", cell: (t) => limitLabel(t.rpm), sortValue: (t) => unlimitedLast(t.rpm) },
      { key: "tpm", header: "Tokens a minute", align: "right", cell: (t) => limitLabel(t.tpm), sortValue: (t) => unlimitedLast(t.tpm), hideBelow: "sm" },
      { key: "concurrency", header: "At once", align: "right", cell: (t) => limitLabel(t.concurrency), sortValue: (t) => unlimitedLast(t.concurrency), hideBelow: "sm" },
      { key: "users", header: "Accounts", align: "right", cell: (t) => formatCount(t.userCount), sortValue: (t) => t.userCount, hideBelow: "md" },
      {
        key: "menu",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        className: "w-10",
        cell: (t) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Actions for ${t.name}`} size="sm" data-testid={`tier-menu-${t.name}`}>
                <MoreHorizontal />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(t)}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDeleting(t)} disabled={t.isDefault} className="text-danger">
                {t.isDefault ? "The default tier cannot be deleted" : "Delete"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [],
  );
  return (
    <AdminPage
      title="Limits"
      description="Rate-limit tiers for accounts. Each limit applies per account across all its keys; a key can set tighter limits of its own. Every account is on the default tier unless you move it."
      actions={
        <Button onClick={() => setEditing("new")} data-testid="tier-add">
          Add tier
        </Button>
      }
      testId="admin-tiers"
    >
      <DataTable
        caption="Rate-limit tiers"
        rows={q.data ?? []}
        columns={columns}
        rowKey={(t) => t.id}
        onRowClick={(t) => setEditing(t)}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonRows={3}
        empty={{ title: "No tiers yet." }}
        rowTestId={(t) => `tier-row-${t.name}`}
        testId="tiers-table"
      />
      <p className="mt-4 text-[13px] text-muted-foreground">To move one account to another tier, open it on the Users page.</p>
      <TierDialog value={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the ${deleting?.name ?? ""} tier?`}
        description={deleting?.userCount ? `Its ${formatCount(deleting.userCount)} ${deleting.userCount === 1 ? "account moves" : "accounts move"} to the default tier.` : "No accounts use it."}
        confirmLabel="Delete tier"
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

const BLANK: TierDraft = { name: "", rpm: "", tpm: "", concurrency: "", isDefault: false };

function TierDialog({ value, onClose }: { value: LimitTier | "new" | null; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const existing = value && value !== "new" ? value : null;
  const [d, setD] = useState<TierDraft>(BLANK);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!value) return;
    setError(null);
    setD(existing ? { name: existing.name, rpm: limitText(existing.rpm), tpm: limitText(existing.tpm), concurrency: limitText(existing.concurrency), isDefault: existing.isDefault } : BLANK);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = tierDraftErrors(d);
  const ok = Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => {
      const body: TierInput = { name: d.name.trim(), rpm: parseLimit(d.rpm) ?? null, tpm: parseLimit(d.tpm) ?? null, concurrency: parseLimit(d.concurrency, 10_000) ?? null, isDefault: d.isDefault };
      return existing ? api().admin.updateTier(existing.id, body) : api().admin.createTier(body);
    },
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.tiers, list);
      void qc.invalidateQueries({ queryKey: ak.usersPrefix });
      toast.success({ title: existing ? "Tier saved" : "Tier added" });
      onClose();
    },
  });
  const set = <K extends keyof TierDraft>(k: K, v: TierDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="tier-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "Add a tier"}</DialogTitle>
            <DialogDescription>Leave a limit empty for unlimited.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Name" htmlFor={`${id}-name`} error={d.name ? errs.name : undefined}>
              <Input id={`${id}-name`} value={d.name} maxLength={60} onChange={(e) => set("name", e.target.value)} data-testid="tier-name" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Requests a minute" htmlFor={`${id}-rpm`} error={errs.rpm}>
                <Input id={`${id}-rpm`} inputMode="numeric" placeholder="Unlimited" value={d.rpm} onChange={(e) => set("rpm", e.target.value)} data-testid="tier-rpm" />
              </Field>
              <Field label="Tokens a minute" htmlFor={`${id}-tpm`} error={errs.tpm}>
                <Input id={`${id}-tpm`} inputMode="numeric" placeholder="Unlimited" value={d.tpm} onChange={(e) => set("tpm", e.target.value)} data-testid="tier-tpm" />
              </Field>
              <Field label="Requests at once" htmlFor={`${id}-conc`} error={errs.concurrency}>
                <Input id={`${id}-conc`} inputMode="numeric" placeholder="Unlimited" value={d.concurrency} onChange={(e) => set("concurrency", e.target.value)} data-testid="tier-concurrency" />
              </Field>
            </div>
            <label className="flex items-center justify-between gap-4 border-t border-border pt-4 text-[14px]">
              <span>
                <span className="font-medium">Default tier</span>
                <span className="block text-[13px] text-muted-foreground">
                  {existing?.isDefault ? "To change the default, make another tier the default." : "New accounts and accounts without a tier use it. There is always exactly one default."}
                </span>
              </span>
              <Switch checked={d.isDefault} onCheckedChange={(v) => set("isDefault", v)} disabled={!!existing?.isDefault} data-testid="tier-default" />
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
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="tier-save">
              {existing ? "Save" : "Add tier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
