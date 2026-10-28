"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flattenPages, nextCursor } from "@open-gateway/api-client";
import { X } from "lucide-react";
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Switch, toast } from "@open-gateway/ui";
import type { AdminTopupRow, PromoCode, TopupStatus } from "@open-gateway/types";
import { api } from "@/lib/api";
import { TOPUP_STATUS_LABEL, TOPUP_STATUS_TONE, adminErrorMessage, formatCount, promoDraftBody, promoDraftErrors, promoState, shortDate, type PromoDraft } from "@/lib/admin";
import { minor, usd } from "@/lib/money";
import { TimeAgo } from "@/components/common/time-ago";
import { AdminPage, AdminSection, DataTable, FilterBar, ReasonDialog, StatusText, useUrlState, type Column } from "../shell";
import { adminMutation, ak, PersonAvatar } from "./common";

const STATUS_TABS: { value: "all" | TopupStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "PAID", label: "Paid" },
  { value: "CREATED", label: "Started" },
  { value: "FAILED", label: "Failed" },
  { value: "REFUNDED", label: "Refunded" },
];
const isStatus = (v: string): v is TopupStatus => STATUS_TABS.some((t) => t.value === v && v !== "all");

const GATEWAY_LABEL: Record<AdminTopupRow["gateway"], string> = { STRIPE: "Stripe", RAZORPAY: "Razorpay", STUB: "Stub" };

export function AdminBilling() {
  return (
    <AdminPage title="Billing" description="Top-ups people paid for and the promo codes they can redeem. Amounts are what they paid, tax included; credit is what landed in their wallet." testId="admin-billing">
      <Topups />
      <Promos />
    </AdminPage>
  );
}

function Topups() {
  const qc = useQueryClient();
  const url = useUrlState();
  const statusParam = url.get("status");
  const status = isStatus(statusParam) ? statusParam : undefined;
  const userId = url.get("user") || undefined;
  const [refunding, setRefunding] = useState<AdminTopupRow | null>(null);
  const list = useInfiniteQuery({
    queryKey: ak.topups({ status, userId }),
    queryFn: ({ pageParam }) => api().admin.topups({ status, userId, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextCursor,
    placeholderData: (p) => p,
  });
  const rows = flattenPages(list.data?.pages);
  const owner = userId ? rows.find((r) => r.owner.id === userId)?.owner : undefined;

  const columns = useMemo<Column<AdminTopupRow>[]>(
    () => [
      {
        key: "owner",
        header: "Account",
        cell: (t) => (
          <div className="flex min-w-0 items-center gap-3">
            <PersonAvatar user={t.owner} size="sm" />
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{t.owner.displayName}</p>
              <p className="truncate text-[12.5px] text-muted-foreground">@{t.owner.username}</p>
            </div>
          </div>
        ),
      },
      { key: "paid", header: "Paid", align: "right", cell: (t) => minor(t.totalMinor, t.currency) },
      { key: "credit", header: "Credit", align: "right", cell: (t) => usd(t.creditMicros), hideBelow: "sm" },
      { key: "gateway", header: "Gateway", cell: (t) => <span className="text-muted-foreground">{GATEWAY_LABEL[t.gateway]}</span>, hideBelow: "md" },
      { key: "status", header: "Status", cell: (t) => <StatusText tone={TOPUP_STATUS_TONE[t.status]}>{TOPUP_STATUS_LABEL[t.status]}</StatusText> },
      { key: "created", header: "Started", align: "right", cell: (t) => <TimeAgo value={t.createdAt} className="text-muted-foreground" />, hideBelow: "lg" },
      { key: "paidAt", header: "Paid on", align: "right", cell: (t) => (t.paidAt ? <span className="text-muted-foreground">{shortDate(t.paidAt)}</span> : <span className="text-subtle-foreground">Not paid</span>), hideBelow: "md" },
      {
        key: "refund",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        cell: (t) =>
          t.status === "PAID" ? (
            <Button variant="ghost" size="sm" onClick={() => setRefunding(t)} aria-label={`Refund ${t.owner.displayName}'s top-up of ${minor(t.totalMinor, t.currency)}`} data-testid={`topup-refund-${t.id}`}>
              Refund
            </Button>
          ) : null,
      },
    ],
    [],
  );

  return (
    <AdminSection title="Top-ups" id="topups">
      <FilterBar tabs={STATUS_TABS} tab={status ?? "all"} onTabChange={(v) => url.set({ status: v === "all" ? null : v })} tabsLabel="Top-up status" testId="topups-filter" className="mb-3" />
      {userId ? (
        <p className="mb-3 text-[13px] text-muted-foreground">
          Showing top-ups by {owner ? owner.displayName : "one account"}.{" "}
          <button type="button" onClick={() => url.set({ user: null })} className="inline-flex items-center gap-1 text-foreground hover:underline" aria-label="Show every account's top-ups">
            Show everyone <X className="size-3.5" aria-hidden />
          </button>
        </p>
      ) : null}
      <DataTable
        caption="Top-ups"
        rows={rows}
        columns={columns}
        rowKey={(t) => t.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        hasMore={!!list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        empty={{ title: status || userId ? "No top-ups match." : "No top-ups yet." }}
        rowTestId={(t) => `topup-row-${t.id}`}
        testId="topups-table"
      />
      <ReasonDialog
        open={!!refunding}
        onOpenChange={(o) => !o && setRefunding(null)}
        title={refunding ? `Refund ${minor(refunding.totalMinor, refunding.currency)} to ${refunding.owner.displayName}?` : "Refund"}
        description={
          refunding
            ? `This marks the top-up refunded and takes ${usd(refunding.creditMicros)} back out of their wallet, which can leave it below zero. Send the money back in the ${GATEWAY_LABEL[refunding.gateway]} dashboard yourself.`
            : undefined
        }
        confirmLabel="Mark refunded"
        destructive
        reason="required"
        reasonMaxLength={200}
        onConfirm={async ({ reason }) => {
          await api().admin.refundTopup(refunding!.id, reason);
          toast.success({ title: "Top-up marked refunded" });
          void qc.invalidateQueries({ queryKey: ak.topupsPrefix });
          void qc.invalidateQueries({ queryKey: ak.usersPrefix });
          void qc.invalidateQueries({ queryKey: ak.user(refunding!.owner.id) });
        }}
        testId="refund-dialog"
      />
    </AdminSection>
  );
}

function Promos() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ak.promos, queryFn: () => api().admin.promos() });
  const [creating, setCreating] = useState(false);
  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api().admin.setPromoActive(id, active),
    ...adminMutation(),
    onMutate: ({ id, active }) => {
      const prev = qc.getQueryData<PromoCode[]>(ak.promos);
      if (prev) qc.setQueryData<PromoCode[]>(ak.promos, prev.map((p) => (p.id === id ? { ...p, active } : p)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ak.promos, ctx.prev);
      toast.error({ title: adminErrorMessage(e) });
    },
    onSuccess: (list) => qc.setQueryData(ak.promos, list),
  });
  const columns = useMemo<Column<PromoCode>[]>(
    () => [
      { key: "code", header: "Code", cell: (p) => <span className="font-mono text-[13.5px] font-medium text-foreground">{p.code}</span>, sortValue: (p) => p.code },
      { key: "amount", header: "Credit", align: "right", cell: (p) => usd(p.amountMicros), sortValue: (p) => p.amountMicros },
      {
        key: "used",
        header: "Redeemed",
        align: "right",
        cell: (p) => (p.maxRedemptions === null ? formatCount(p.redeemedCount) : `${formatCount(p.redeemedCount)} of ${formatCount(p.maxRedemptions)}`),
        sortValue: (p) => p.redeemedCount,
      },
      { key: "expires", header: "Expires", align: "right", cell: (p) => (p.expiresAt ? shortDate(p.expiresAt) : <span className="text-subtle-foreground">Never</span>), sortValue: (p) => p.expiresAt, hideBelow: "sm" },
      {
        key: "state",
        header: "State",
        cell: (p) => {
          const s = promoState(p);
          return <StatusText tone={s.tone}>{s.label}</StatusText>;
        },
        hideBelow: "sm",
      },
      {
        key: "active",
        header: "On",
        align: "right",
        cell: (p) => <Switch checked={p.active} onCheckedChange={(v) => toggle.mutate({ id: p.id, active: v })} aria-label={`${p.active ? "Turn off" : "Turn on"} ${p.code}`} data-testid={`promo-active-${p.code}`} />,
      },
    ],
    [toggle],
  );
  return (
    <AdminSection
      title="Promo codes"
      id="promos"
      description="Each code adds credit once per account. Turn a code off to stop new redemptions."
      actions={
        <Button variant="outline" size="sm" onClick={() => setCreating(true)} data-testid="promo-add">
          New code
        </Button>
      }
    >
      <DataTable
        caption="Promo codes"
        rows={q.data ?? []}
        columns={columns}
        rowKey={(p) => p.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        skeletonRows={3}
        empty={{ title: "No promo codes yet." }}
        rowTestId={(p) => `promo-row-${p.code}`}
        testId="promos-table"
      />
      <PromoDialog open={creating} onClose={() => setCreating(false)} />
    </AdminSection>
  );
}

const BLANK: PromoDraft = { code: "", amount: "", maxRedemptions: "", expires: "" };

function PromoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const [d, setD] = useState<PromoDraft>(BLANK);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setD(BLANK);
      setError(null);
    }
  }, [open]);
  const errs = promoDraftErrors(d);
  const ok = Object.keys(errs).length === 0;
  const save = useMutation({
    mutationFn: () => api().admin.createPromo(promoDraftBody(d)),
    ...adminMutation({ inline: true }),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (list) => {
      qc.setQueryData(ak.promos, list);
      toast.success({ title: `${d.code.trim()} created` });
      onClose();
    },
  });
  const set = <K extends keyof PromoDraft>(k: K, v: PromoDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent size="md" data-testid="promo-dialog">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>New promo code</DialogTitle>
            <DialogDescription>People type the code on their billing page to get the credit.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Code" htmlFor={`${id}-code`} error={d.code ? errs.code : undefined} hint="3 to 40 letters, digits, hyphens or underscores.">
              <Input id={`${id}-code`} value={d.code} maxLength={40} onChange={(e) => set("code", e.target.value)} className="font-mono" autoComplete="off" placeholder="LAUNCH25" data-testid="promo-code" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Credit, US dollars" htmlFor={`${id}-amount`} error={d.amount ? errs.amount : undefined}>
                <Input id={`${id}-amount`} inputMode="decimal" value={d.amount} onChange={(e) => set("amount", e.target.value)} placeholder="5.00" data-testid="promo-amount" />
              </Field>
              <Field label="Max redemptions" htmlFor={`${id}-max`} optional error={errs.maxRedemptions} hint="Empty for no limit.">
                <Input id={`${id}-max`} inputMode="numeric" value={d.maxRedemptions} onChange={(e) => set("maxRedemptions", e.target.value)} data-testid="promo-max" />
              </Field>
            </div>
            <Field label="Expires" htmlFor={`${id}-exp`} optional error={errs.expires} hint="At the end of that day, UTC. Empty never expires.">
              <Input id={`${id}-exp`} type="date" value={d.expires} onChange={(e) => set("expires", e.target.value)} className="w-48" data-testid="promo-expires" />
            </Field>
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
            <Button type="submit" disabled={!ok} loading={save.isPending} data-testid="promo-save">
              Create code
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
