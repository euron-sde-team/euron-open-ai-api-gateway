"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { mapPages } from "@open-gateway/api-client";
import { Button, Field, Input, Select, Textarea, toast } from "@open-gateway/ui";
import type { AdminUserDetail, AdminUserRow, LimitTier, Page, UserRole } from "@open-gateway/types";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ROLE_LABEL, STATUS_LABEL, STATUS_TONE, accountActions, adminErrorMessage, creditErrors, formatCount, limitLabel, marginText, parseMargin, parseSignedDollars, shortDate } from "@/lib/admin";
import { bpsLabel, signedUsd, usd } from "@/lib/money";
import { fullTimestamp } from "@/lib/time";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Chart, DetailSection, DetailSheet, FactList, ReasonDialog, StatusText } from "../shell";
import { adminMutation, ak, LineItem, PersonAvatar } from "./common";

const DEFAULT_TIER = "__default";

type Dialog = null | "makeAdmin" | "removeAdmin" | "suspend" | "unsuspend" | "ban" | "unban" | "erase";

/** The list-row part of a detail, to patch list pages without dragging the detail along. */
function rowOf(d: AdminUserDetail): AdminUserRow {
  const { reservedMicros: _r, keys: _k, totals: _t, usage: _u, ...row } = d;
  return row;
}

export function UserSheet({ userId, tiers, onClose }: { userId: string | null; tiers: LimitTier[]; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useAuth().user;
  const [dialog, setDialog] = useState<Dialog>(null);
  const q = useQuery({ queryKey: ak.user(userId ?? ""), queryFn: () => api().admin.user(userId!), enabled: !!userId });
  const u = q.data;

  /** Put a changed row everywhere it shows: the open detail and every loaded list page. */
  const applyRow = (row: AdminUserRow) => {
    qc.setQueryData<AdminUserDetail>(ak.user(row.id), (d) => (d ? { ...d, ...row } : d));
    qc.setQueriesData<InfiniteData<Page<AdminUserRow>>>({ queryKey: ak.usersPrefix }, (old) => (old ? { ...old, pages: mapPages(old.pages, (r) => (r.id === row.id ? { ...r, ...row } : r)) } : old));
  };
  const applyDetail = (d: AdminUserDetail) => {
    qc.setQueryData(ak.user(d.id), d);
    applyRow(rowOf(d));
  };
  const refreshLists = () => void qc.invalidateQueries({ queryKey: ak.usersPrefix });

  const role = useMutation({
    mutationFn: (next: UserRole) => api().admin.setRole(userId!, next),
    ...adminMutation({ inline: true }),
    onSuccess: (row) => {
      applyRow(row);
      toast.success({ title: row.role === "ADMIN" ? `${row.displayName} is now an admin` : `${row.displayName} is no longer an admin` });
    },
  });
  const tier = useMutation({
    mutationFn: (tierId: string | null) => api().admin.setTier(userId!, tierId),
    ...adminMutation(),
    onMutate: (tierId) => {
      // Instant: show the new tier while the request runs.
      const prev = qc.getQueryData<AdminUserDetail>(ak.user(userId!));
      const t = tiers.find((x) => x.id === tierId);
      if (prev) qc.setQueryData<AdminUserDetail>(ak.user(userId!), { ...prev, limitTier: t ? { id: t.id, name: t.name } : null });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ak.user(userId!), ctx.prev);
      toast.error({ title: adminErrorMessage(e) });
    },
    onSuccess: (row) => {
      applyRow(row);
      void qc.invalidateQueries({ queryKey: ak.tiers });
    },
  });
  const simple = useMutation({
    mutationFn: (action: "unsuspend" | "unban") => (action === "unsuspend" ? api().admin.unsuspend(userId!) : api().admin.unban(userId!)),
    ...adminMutation({ inline: true }),
    onSuccess: (row) => applyRow(row),
  });

  if (!userId) return <DetailSheet open={false} onOpenChange={() => onClose()} title="" />;
  const can = u ? accountActions(u, me?.id) : null;
  const currentTier = u ? (u.limitTier ? tiers.find((t) => t.id === u.limitTier!.id) : tiers.find((t) => t.isDefault)) : undefined;

  return (
    <DetailSheet
      open={!!userId}
      onOpenChange={(o) => !o && onClose()}
      title={u?.displayName ?? ""}
      description={u ? `@${u.username} · ${u.email}` : undefined}
      leading={u ? <PersonAvatar user={u} size="lg" /> : undefined}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      testId="user-sheet"
    >
      {u && can ? (
        <>
          <DetailSection title="Account">
            <FactList
              items={[
                { label: "Status", value: <StatusText tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}{u.status === "SUSPENDED" && u.suspendedUntil ? ` until ${shortDate(u.suspendedUntil)}` : ""}</StatusText> },
                { label: "Role", value: ROLE_LABEL[u.role] },
                { label: "Balance", value: <span className={u.balanceMicros < 0 ? "text-danger" : undefined} data-testid="user-balance">{usd(u.balanceMicros)}</span> },
                { label: "On hold", value: usd(u.reservedMicros) },
                { label: "Spent this month", value: usd(u.spentThisMonthMicros) },
                { label: "Joined", value: <span title={fullTimestamp(u.createdAt)}>{shortDate(u.createdAt)}</span> },
                { label: "Last seen", value: u.lastSeenAt ? <span title={fullTimestamp(u.lastSeenAt)}>{shortDate(u.lastSeenAt)}</span> : "Never" },
              ]}
            />
          </DetailSection>

          <DetailSection title="Credit">
            <CreditForm userId={u.id} disabled={can.erased} onSaved={applyDetail} />
          </DetailSection>

          <DetailSection title="Margin">
            <p className="mb-3 text-[13px] text-muted-foreground">A key margin beats the account margin, which beats the model&apos;s margin and then the default. Empty means not set.</p>
            <MarginRow
              label="Account margin"
              value={u.marginBps}
              disabled={can.erased}
              onSave={(bps) => api().admin.setUserMargin(u.id, bps)}
              onSaved={applyDetail}
              testId="user-margin"
            />
            {u.keys.length ? (
              <ul className="mt-2 border-t border-border" aria-label="API keys" data-testid="user-keys">
                {u.keys.map((k) => (
                  <li key={k.id} className="border-b border-border py-3 last:border-b-0" data-testid={`user-key-${k.id}`}>
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="min-w-0 text-[14px] font-medium text-foreground">
                        {k.name} <span className="font-mono text-[12.5px] font-normal text-muted-foreground">{k.hint}</span>
                      </p>
                      <p className="text-[12.5px] text-muted-foreground">
                        {k.status === "REVOKED" ? <StatusText tone="muted">Revoked</StatusText> : k.lastUsedAt ? `Used ${shortDate(k.lastUsedAt)}` : "Never used"}
                      </p>
                    </div>
                    <MarginRow
                      label={`Margin for ${k.name}`}
                      value={k.marginBps}
                      disabled={can.erased || k.status === "REVOKED"}
                      onSave={(bps) => api().admin.setKeyMargin(u.id, k.id, bps)}
                      onSaved={applyDetail}
                      testId={`key-margin-${k.id}`}
                      compact
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-muted-foreground">No API keys yet.</p>
            )}
          </DetailSection>

          <DetailSection title="Rate limits">
            <Select
              aria-label="Rate-limit tier"
              value={u.limitTier?.id ?? DEFAULT_TIER}
              onValueChange={(v) => tier.mutate(v === DEFAULT_TIER ? null : v)}
              disabled={can.erased || tier.isPending}
              options={[{ value: DEFAULT_TIER, label: `Whichever tier is the default${defaultName(tiers)}` }, ...tiers.map((t) => ({ value: t.id, label: t.name }))]}
              data-testid="user-tier"
            />
            {currentTier ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                {limitLabel(currentTier.rpm)} requests and {limitLabel(currentTier.tpm).toLowerCase()} tokens a minute, {limitLabel(currentTier.concurrency).toLowerCase()} at once.
              </p>
            ) : null}
          </DetailSection>

          <DetailSection
            title="Last 30 days"
            action={
              <Button asChild variant="link" size="sm" className="text-[13px]">
                <Link href={`/admin/topups?user=${encodeURIComponent(u.id)}`} data-testid="user-topups-link">
                  See their top-ups
                </Link>
              </Button>
            }
          >
            <SpendChart usage={u.usage} />
            <FactList
              className="mt-4"
              items={[
                { label: "Requests in total", value: formatCount(u.totals.requests) },
                { label: "Spent in total", value: usd(u.totals.spendMicros) },
                { label: "Topped up", value: usd(u.totals.topupsMicros) },
                { label: "Credits", value: usd(u.totals.creditsMicros) },
              ]}
            />
          </DetailSection>

          <DetailSection title="Access">
            {can.self ? (
              <p className="text-[13.5px] text-muted-foreground">This is your account. Another admin can change its role or access.</p>
            ) : can.erased ? (
              <p className="text-[13.5px] text-muted-foreground">This account was erased. Its ledger and top-ups are kept for the books.</p>
            ) : (
              <div>
                {can.makeAdmin ? <LineItem title="Make admin" description="Opens this control plane to them." control={<Button variant="outline" size="sm" onClick={() => setDialog("makeAdmin")} data-testid="user-make-admin">Make admin</Button>} /> : null}
                {can.removeAdmin ? <LineItem title="Remove admin" description="Signs them out of the admin area at once." control={<Button variant="outline" size="sm" onClick={() => setDialog("removeAdmin")} data-testid="user-remove-admin">Remove admin</Button>} /> : null}
                {can.suspend ? <LineItem title="Suspend" description="Their API keys stop working for a number of days. They can still sign in and see their usage." control={<Button variant="outline" size="sm" onClick={() => setDialog("suspend")} data-testid="user-suspend">Suspend</Button>} /> : null}
                {can.unsuspend ? <LineItem title="Lift the suspension" description={u.suspendedUntil ? `Ends on its own on ${shortDate(u.suspendedUntil)}.` : undefined} control={<Button variant="outline" size="sm" onClick={() => setDialog("unsuspend")} data-testid="user-unsuspend">Unsuspend</Button>} /> : null}
                {can.ban ? <LineItem title="Ban" description="Signs them out everywhere and their keys stop working." control={<Button variant="danger-ghost" size="sm" onClick={() => setDialog("ban")} data-testid="user-ban">Ban</Button>} /> : null}
                {can.unban ? <LineItem title="Unban" description="They can sign in and use their keys again." control={<Button variant="outline" size="sm" onClick={() => setDialog("unban")} data-testid="user-unban">Unban</Button>} /> : null}
                {can.erase ? <LineItem title="Erase" description="Anonymises the account, revokes every key and deletes logged request bodies. The ledger and top-ups are kept. This cannot be undone." control={<Button variant="danger-ghost" size="sm" onClick={() => setDialog("erase")} data-testid="user-erase">Erase</Button>} /> : null}
                {u.role === "ADMIN" ? <p className="pt-3 text-[13px] text-muted-foreground">Admins cannot be suspended, banned or erased. Remove admin first.</p> : null}
              </div>
            )}
          </DetailSection>

          <ConfirmDialog
            open={dialog === "makeAdmin" || dialog === "removeAdmin"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={dialog === "makeAdmin" ? `Make ${u.displayName} an admin?` : `Remove admin from ${u.displayName}?`}
            description={dialog === "makeAdmin" ? "They will see every account and balance, the providers, the catalogue and the settings. Never request bodies or provider secrets." : "They keep their account and keys, and lose the admin area right away."}
            confirmLabel={dialog === "makeAdmin" ? "Make admin" : "Remove admin"}
            destructive={dialog === "removeAdmin"}
            onConfirm={() => toastOnFail(role.mutateAsync(dialog === "makeAdmin" ? "ADMIN" : "USER"))}
          />
          <ConfirmDialog
            open={dialog === "unsuspend" || dialog === "unban"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={dialog === "unsuspend" ? `Lift ${u.displayName}'s suspension?` : `Unban ${u.displayName}?`}
            description={dialog === "unsuspend" ? "Their keys work again right away." : "They can sign in and use their keys again."}
            confirmLabel={dialog === "unsuspend" ? "Unsuspend" : "Unban"}
            onConfirm={() => toastOnFail(simple.mutateAsync(dialog === "unsuspend" ? "unsuspend" : "unban"))}
          />
          <ReasonDialog
            open={dialog === "suspend"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Suspend ${u.displayName}`}
            description="Their API keys stop working until the suspension ends."
            confirmLabel="Suspend"
            days={7}
            maxDays={365}
            reason="optional"
            onConfirm={async ({ days, reason }) => applyRow(await api().admin.suspend(u.id, days, reason || undefined))}
            testId="suspend-dialog"
          />
          <ReasonDialog
            open={dialog === "ban"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Ban ${u.displayName}`}
            description="They are signed out everywhere and their keys stop working."
            confirmLabel="Ban"
            destructive
            reason="optional"
            onConfirm={async ({ reason }) => applyRow(await api().admin.ban(u.id, reason || undefined))}
            testId="ban-dialog"
          />
          <ReasonDialog
            open={dialog === "erase"}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Erase ${u.displayName}`}
            description="The account is anonymised now, every key is revoked and logged request bodies are deleted. The ledger and top-ups are kept. This cannot be undone."
            confirmLabel="Erase account"
            destructive
            reason="required"
            typeToConfirm={u.username}
            onConfirm={async ({ reason }) => {
              await api().admin.erase(u.id, reason);
              await q.refetch();
              refreshLists();
              toast.success({ title: "Account erased" });
            }}
            testId="erase-dialog"
          />
        </>
      ) : null}
    </DetailSheet>
  );
}

/** ConfirmDialog keeps itself open on a throw; show the admin copy as a toast too. */
async function toastOnFail<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    toast.error({ title: adminErrorMessage(e) });
    throw e;
  }
}

const defaultName = (tiers: LimitTier[]) => {
  const d = tiers.find((t) => t.isDefault);
  return d ? ` (${d.name})` : "";
};

function SpendChart({ usage }: { usage: AdminUserDetail["usage"] }) {
  const data = useMemo(() => usage.map((d) => ({ date: d.date, spend: d.spendMicros / 1_000_000, requests: d.requests })), [usage]);
  if (!usage.some((d) => d.requests > 0 || d.spendMicros > 0)) return <p className="text-[13.5px] text-muted-foreground">No requests in the last 30 days.</p>;
  return (
    <Chart
      data={data}
      series={[{ key: "spend", label: "Spend", tone: "primary" }]}
      type="bar"
      height={150}
      integer={false}
      formatValue={(n) => usd(Math.round(n * 1_000_000))}
      title="Spend per day, last 30 days, US dollars"
      testId="user-usage"
    />
  );
}

/** One margin override: a percent field, Save and Clear. Empty saves as "not set". */
function MarginRow({
  label, value, disabled, onSave, onSaved, testId, compact,
}: {
  label: string;
  value: number | null;
  disabled?: boolean;
  onSave: (bps: number | null) => Promise<AdminUserDetail>;
  onSaved: (d: AdminUserDetail) => void;
  testId: string;
  compact?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(marginText(value));
  useEffect(() => setText(marginText(value)), [value]);
  const parsed = parseMargin(text);
  const dirty = parsed !== undefined && parsed !== value;
  const save = useMutation({
    mutationFn: (bps: number | null) => onSave(bps),
    ...adminMutation(),
    onSuccess: (d, bps) => {
      onSaved(d);
      toast.success({ title: bps === null ? `${label} cleared` : `${label} set to ${bpsLabel(bps, true)}` });
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate(parsed);
      }}
      data-testid={testId}
    >
      <Field label={compact ? <span className="sr-only">{label}</span> : label} htmlFor={`${id}-m`} error={parsed === undefined ? "A percent from 0 to 1000." : undefined} className="min-w-0 flex-1">
        <div className="relative">
          <Input id={`${id}-m`} inputMode="decimal" placeholder="Not set" value={text} onChange={(e) => setText(e.target.value)} disabled={disabled || save.isPending} className="pr-8" data-testid={`${testId}-input`} />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-subtle-foreground" aria-hidden>
            %
          </span>
        </div>
      </Field>
      <Button type="submit" size="sm" variant="outline" className="mb-1" disabled={!dirty || disabled} loading={save.isPending} data-testid={`${testId}-save`}>
        Save
      </Button>
      {value !== null ? (
        <Button type="button" size="sm" variant="ghost" className="mb-1" onClick={() => save.mutate(null)} disabled={disabled || save.isPending} data-testid={`${testId}-clear`}>
          Clear
        </Button>
      ) : null}
    </form>
  );
}

function CreditForm({ userId, disabled, onSaved }: { userId: string; disabled: boolean; onSaved: (d: AdminUserDetail) => void }) {
  const id = useId();
  const blank = { type: "GRANT" as "GRANT" | "ADJUSTMENT", amount: "", reason: "" };
  const [d, setD] = useState(blank);
  const [touched, setTouched] = useState(false);
  const errs = creditErrors(d);
  const ok = Object.keys(errs).length === 0;
  const amount = parseSignedDollars(d.amount);
  const save = useMutation({
    mutationFn: () => api().admin.credit(userId, { type: d.type, amountMicros: amount!, reason: d.reason.trim() }),
    ...adminMutation(),
    onSuccess: (next) => {
      onSaved(next);
      toast.success({ title: `${signedUsd(amount!)} booked. Balance is now ${usd(next.balanceMicros)}.` });
      setD(blank);
      setTouched(false);
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (ok && !disabled) save.mutate();
      }}
      data-testid="credit-form"
    >
      <p className="text-[13px] text-muted-foreground">A grant adds free credit. An adjustment corrects the balance either way. Both go on their ledger and in the audit log.</p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Type" htmlFor={`${id}-t`}>
          <Select
            id={`${id}-t`}
            value={d.type}
            onValueChange={(v) => setD((x) => ({ ...x, type: v as "GRANT" | "ADJUSTMENT" }))}
            options={[
              { value: "GRANT", label: "Grant" },
              { value: "ADJUSTMENT", label: "Adjustment" },
            ]}
            disabled={disabled}
            data-testid="credit-type"
          />
        </Field>
        <Field label="Amount, US dollars" htmlFor={`${id}-a`} error={touched || d.amount ? errs.amount : undefined} hint={d.type === "ADJUSTMENT" ? "Use a minus sign to take credit away." : undefined}>
          <Input id={`${id}-a`} inputMode="decimal" placeholder={d.type === "GRANT" ? "10.00" : "-4.20"} value={d.amount} onChange={(e) => setD((x) => ({ ...x, amount: e.target.value }))} disabled={disabled} data-testid="credit-amount" />
        </Field>
      </div>
      <Field label="Reason" htmlFor={`${id}-r`} error={touched ? errs.reason : undefined} hint="Shown on their ledger.">
        <Textarea id={`${id}-r`} rows={2} maxLength={300} value={d.reason} onChange={(e) => setD((x) => ({ ...x, reason: e.target.value }))} disabled={disabled} data-testid="credit-reason" />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={disabled || (touched && !ok)} loading={save.isPending} data-testid="credit-save">
          {d.type === "GRANT" ? "Grant credit" : "Book adjustment"}
        </Button>
      </div>
    </form>
  );
}
