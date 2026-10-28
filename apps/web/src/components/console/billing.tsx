"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AppMeta, LedgerEntry, Topup, TopupOrder } from "@open-gateway/types";
import { Button, Field, Input, Segmented, toast } from "@open-gateway/ui";
import { api } from "@/lib/api";
import { useInvalidateMoney, useLedger, useTopups, useWallet } from "@/lib/console";
import { saveBlob } from "@/lib/download";
import { errorMessage } from "@/lib/errors";
import { useAppMeta } from "@/lib/meta";
import { inr, minor, previewTopup, signedUsd, usd } from "@/lib/money";
import { qk } from "@/lib/query-keys";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataTable, StatLine, StatusText, type Column } from "@/components/admin/shell";
import { ConsolePage, Section } from "./page";

type Currency = "USD" | "INR";
type TopupOption = AppMeta["billing"]["topups"][number];

const LEDGER_LABEL: Record<LedgerEntry["type"], string> = { TOPUP: "Top-up", GRANT: "Credit", PROMO: "Promo code", SIGNUP: "Welcome credit", USAGE: "Usage", REFUND: "Refund", ADJUSTMENT: "Adjustment" };
const PRESETS: Record<Currency, number[]> = { USD: [10, 25, 50, 100], INR: [500, 1000, 2500, 5000] };

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, fn: (r: unknown) => void) => void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Razorpay could not be loaded. Check your connection and try again."));
    document.body.appendChild(s);
  });
}

export function BillingPage() {
  const meta = useAppMeta();
  const wallet = useWallet();
  const invalidate = useInvalidateMoney();
  const params = useSearchParams();
  const router = useRouter();
  const returning = params.get("topup");
  const cancelled = params.get("cancelled") === "1";

  useEffect(() => {
    if (returning && cancelled) {
      toast.info("Checkout cancelled. Nothing was charged.");
      router.replace("/billing");
    }
  }, [returning, cancelled, router]);

  return (
    <ConsolePage title="Billing" description="One balance in US dollars pays for every request. Top up in dollars or rupees; rupee top-ups are converted at the rate shown when you pay." testId="billing-page" wide>
      <StatLine
        size="lg"
        loading={!wallet.data}
        items={[
          { label: "Available", value: wallet.data ? usd(wallet.data.availableMicros) : "", hint: wallet.data ? `about ${inr(wallet.data.balanceInr)}` : undefined, testId: "wallet-available" },
          { label: "On hold", value: wallet.data ? usd(wallet.data.reservedMicros) : "", hint: "for requests in flight" },
          { label: "Balance", value: wallet.data ? usd(wallet.data.balanceMicros) : "" },
        ]}
      />
      {returning && !cancelled ? <ReturnWatcher id={returning} onDone={() => (void invalidate(), router.replace("/billing"))} /> : null}
      <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {meta.data ? <TopupForm meta={meta.data} onPaid={() => void invalidate()} /> : <div className="h-64 animate-shimmer rounded-md bg-muted" />}
        <Promo onRedeemed={() => void invalidate()} />
      </div>
      <Ledger />
      <Topups />
    </ConsolePage>
  );
}

/** Back from Stripe: the webhook credits the wallet; poll the top-up until it is paid. */
function ReturnWatcher({ id, onDone }: { id: string; onDone: () => void }) {
  const q = useQuery({ queryKey: qk.topup(id), queryFn: () => api().billing.topup(id), refetchInterval: (query) => (query.state.data?.status === "CREATED" ? 2000 : false) });
  const status = q.data?.status;
  useEffect(() => {
    if (status === "PAID") {
      toast.success(`Payment received. ${usd(q.data!.creditMicros)} added to your balance.`);
      onDone();
    } else if (status === "FAILED") {
      toast.error("The payment did not go through. Nothing was credited.");
      onDone();
    }
  }, [status, q.data, onDone]);
  if (status && status !== "CREATED") return null;
  return (
    <p className="mt-8 text-[14px] text-muted-foreground" role="status" data-testid="topup-waiting">
      Waiting for the payment to be confirmed. This usually takes a few seconds; you can leave this page.
    </p>
  );
}

function TopupForm({ meta, onPaid }: { meta: AppMeta; onPaid: () => void }) {
  const options = meta.billing.topups;
  const [currency, setCurrency] = useState<Currency>(options[0]?.currency ?? "USD");
  const option: TopupOption | undefined = options.find((o) => o.currency === currency);
  const [amount, setAmount] = useState(String(PRESETS[currency][1]));
  const [stubOrder, setStubOrder] = useState<TopupOrder | null>(null);
  useEffect(() => setAmount(String(PRESETS[currency][1])), [currency]);

  const n = Number(amount);
  const valid = option && Number.isFinite(n) && n * 100 >= option.minMinor && n * 100 <= option.maxMinor;
  const preview = useMemo(() => (valid ? previewTopup(currency, n, meta.billing.taxBps, meta.billing.inrPerUsd) : null), [valid, currency, n, meta.billing]);

  const verify = useMutation({
    mutationFn: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => api().billing.verifyRazorpay({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
    onSuccess: (t: Topup) => {
      toast.success(`Payment received. ${usd(t.creditMicros)} added to your balance.`);
      onPaid();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const create = useMutation({
    mutationFn: () => api().billing.createTopup({ currency, amount: n }),
    onSuccess: async (order) => {
      const c = order.checkout;
      if (c.kind === "redirect") {
        window.location.assign(c.url);
      } else if (c.kind === "razorpay") {
        await loadRazorpay();
        const rzp = new window.Razorpay!({
          key: c.keyId,
          amount: c.amount,
          currency: c.currency,
          order_id: c.orderId,
          name: meta.appName,
          description: "Balance top-up",
          handler: (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => verify.mutate(r),
          modal: { ondismiss: () => toast.info("Checkout closed. Nothing was charged.") },
        });
        rzp.on("payment.failed", () => toast.error("The payment did not go through. Nothing was charged."));
        rzp.open();
      } else {
        setStubOrder(order);
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!options.length) {
    return (
      <Section title="Top up">
        <p className="text-[14px] text-muted-foreground">Top-ups are not available on this server yet. An administrator needs to connect Stripe or Razorpay.</p>
      </Section>
    );
  }

  return (
    <Section title="Top up" description={option ? `Between ${minor(option.minMinor, currency)} and ${minor(option.maxMinor, currency)}.` : undefined} className="mt-0 border-t-0 pt-0">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate();
        }}
        data-testid="topup-form"
      >
        {options.length > 1 ? <Segmented<Currency> value={currency} onChange={setCurrency} options={options.map((o) => ({ value: o.currency, label: o.currency === "USD" ? "US dollars" : "Indian rupees" }))} aria-label="Currency" /> : null}
        <div className="flex flex-wrap gap-2">
          {PRESETS[currency].map((p) => (
            <Button key={p} type="button" size="sm" variant={Number(amount) === p ? "secondary" : "ghost"} onClick={() => setAmount(String(p))}>
              {minor(p * 100, currency).replace(/\.00$/, "")}
            </Button>
          ))}
        </div>
        <Field label={`Amount (${currency})`} htmlFor="topup-amount" error={amount && !valid ? "Outside the top-up limits." : undefined}>
          <Input id="topup-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="max-w-48" />
        </Field>
        {preview ? (
          <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-y-1 text-[14px]" data-testid="topup-preview">
            {preview.taxMinor ? (
              <>
                <dt className="text-muted-foreground">{meta.billing.taxLabel}</dt>
                <dd className="text-right tabular-nums">{minor(preview.taxMinor, currency)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">You pay</dt>
            <dd className="text-right tabular-nums">{minor(preview.totalMinor, currency)}</dd>
            <dt className="text-muted-foreground">Added to your balance</dt>
            <dd className="text-right font-medium tabular-nums">{usd(preview.creditMicros)}</dd>
            {currency === "INR" ? <dd className="col-span-2 pt-1 text-[12.5px] text-subtle-foreground">At {inr(meta.billing.inrPerUsd)} per US dollar, locked when you start checkout.</dd> : null}
          </dl>
        ) : null}
        <Button type="submit" disabled={!valid} loading={create.isPending || verify.isPending} data-testid="topup-submit">
          Continue to payment
        </Button>
      </form>
      <ConfirmDialog
        open={!!stubOrder}
        onOpenChange={(o) => !o && setStubOrder(null)}
        title="Test payment"
        description={stubOrder ? `This server uses a test gateway: confirming credits ${usd(stubOrder.creditMicros)} without charging anything. Real deployments use Stripe or Razorpay.` : undefined}
        confirmLabel="Confirm test payment"
        onConfirm={async () => {
          if (!stubOrder) return;
          try {
            const t = await api().billing.confirmStub(stubOrder.id);
            toast.success(`${usd(t.creditMicros)} added to your balance.`);
            onPaid();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
        testId="stub-payment-dialog"
      />
    </Section>
  );
}

function Promo({ onRedeemed }: { onRedeemed: () => void }) {
  const [code, setCode] = useState("");
  const redeem = useMutation({
    mutationFn: () => api().billing.redeem(code.trim()),
    onSuccess: (r) => {
      toast.success(`${usd(r.creditedMicros)} added to your balance.`);
      setCode("");
      onRedeemed();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section title="Promo code" description="Codes add free credit to your balance, once per account." className="mt-0 border-t-0 pt-0">
      <form
        className="flex max-w-sm gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length >= 3) redeem.mutate();
        }}
      >
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="LAUNCH10" aria-label="Promo code" className="uppercase" />
        <Button type="submit" variant="outline" loading={redeem.isPending} disabled={code.trim().length < 3}>
          Redeem
        </Button>
      </form>
    </Section>
  );
}

function Ledger() {
  const list = useLedger();
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const columns: Column<LedgerEntry>[] = [
    { key: "when", header: "When", cell: (e) => <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span> },
    { key: "what", header: "Entry", cell: (e) => <span className="block min-w-0"><span className="block font-medium">{LEDGER_LABEL[e.type]}</span><span className="block truncate text-[12.5px] text-subtle-foreground">{e.description}</span></span> },
    { key: "amount", header: "Amount", align: "right", cell: (e) => <span className={e.amountMicros > 0 ? "tabular-nums text-success" : "tabular-nums"}>{signedUsd(e.amountMicros)}</span> },
    { key: "after", header: "Balance after", align: "right", hideBelow: "md", cell: (e) => <span className="tabular-nums text-muted-foreground">{usd(e.balanceAfterMicros)}</span> },
  ];
  return (
    <Section title="Ledger" description="Every change to your balance. Each request is one Usage entry." className="mt-14">
      <DataTable<LedgerEntry>
        caption="Ledger"
        rows={rows}
        loading={list.isLoading}
        rowKey={(e) => e.id}
        columns={columns}
        hasMore={!!list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
        empty={{ title: "No entries yet" }}
      />
    </Section>
  );
}

function Topups() {
  const list = useTopups();
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const receipt = async (t: Topup) => {
    try {
      saveBlob(await api().billing.receipt(t.id), `receipt-${t.id}.pdf`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const columns: Column<Topup>[] = [
    { key: "when", header: "When", cell: (t) => <span className="text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</span> },
    { key: "paid", header: "Paid", align: "right", cell: (t) => <span className="tabular-nums">{minor(t.totalMinor, t.currency)}</span> },
    { key: "credit", header: "Credited", align: "right", cell: (t) => <span className="tabular-nums">{usd(t.creditMicros)}</span> },
    {
      key: "status",
      header: "Status",
      cell: (t) => <StatusText tone={t.status === "PAID" ? "success" : t.status === "CREATED" ? "muted" : t.status === "REFUNDED" ? "warning" : "danger"}>{t.status === "CREATED" ? "Not paid" : t.status.charAt(0) + t.status.slice(1).toLowerCase()}</StatusText>,
    },
    {
      key: "receipt",
      header: <span className="sr-only">Receipt</span>,
      align: "right",
      cell: (t) =>
        t.status === "PAID" || t.status === "REFUNDED" ? (
          <Button variant="ghost" size="sm" onClick={() => void receipt(t)} aria-label={`Download receipt for the top-up of ${minor(t.totalMinor, t.currency)}`}>
            Receipt
          </Button>
        ) : null,
    },
  ];
  return (
    <Section title="Top-ups" className="mt-14">
      <DataTable<Topup> caption="Top-ups" rows={rows} loading={list.isLoading} rowKey={(t) => t.id} columns={columns} hasMore={!!list.hasNextPage} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} empty={{ title: "No top-ups yet" }} />
    </Section>
  );
}
