"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button, Field, Input, Select, Skeleton, toast } from "@open-gateway/ui";
import type { AppSettings, IntegrationStatus } from "@open-gateway/types";
import { api } from "@/lib/api";
import {
  SETTINGS_GROUP_LABEL, adminErrorMessage, dirtyGroups, fromSettingsForm, parseDomains, settingsErrors, settingsPatch, toSettingsForm, type SettingsForm,
} from "@/lib/admin";
import { fullTimestamp } from "@/lib/time";
import { qk } from "@/lib/query-keys";
import { ErrorState } from "@/components/common/states";
import { AdminPage, AdminSection, FactList, StatusText } from "../shell";
import { adminMutation, ak } from "./common";

export function AdminSettings() {
  const q = useQuery({ queryKey: ak.settings, queryFn: () => api().admin.settings() });
  return (
    <AdminPage title="Settings" description="How this gateway behaves for everyone. Changes apply right away and are recorded in the audit log." testId="admin-settings">
      {q.isError && !q.data ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data ? <SettingsFormView saved={q.data} /> : <FormSkeleton />}
      <Integrations />
    </AdminPage>
  );
}

/** A text input with a unit on the right ("%", "USD", "days"). */
function UnitInput({ id, value, onChange, unit, className, testId, inputMode = "decimal", placeholder }: { id: string; value: string; onChange: (v: string) => void; unit: string; className?: string; testId: string; inputMode?: "decimal" | "numeric"; placeholder?: string }) {
  return (
    <div className={`relative ${className ?? "w-40"}`}>
      <Input id={id} inputMode={inputMode} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="pr-14" data-testid={testId} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-subtle-foreground" aria-hidden>
        {unit}
      </span>
    </div>
  );
}

function SettingsFormView({ saved }: { saved: AppSettings }) {
  const id = useId();
  const qc = useQueryClient();
  const [form, setForm] = useState<SettingsForm>(() => toSettingsForm(saved));
  const [domainText, setDomainText] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A save (or a refetch) replaces the baseline; the draft follows it.
  useEffect(() => setForm(toSettingsForm(saved)), [saved]);

  const errs = settingsErrors(form);
  const valid = Object.keys(errs).length === 0;
  const draft = useMemo(() => fromSettingsForm(form), [form]);
  // Invalid numbers read as NaN, which never equals the saved value: still "dirty".
  const dirty = dirtyGroups(saved, draft);
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api().admin.updateSettings(settingsPatch(saved, draft)),
    ...adminMutation({ inline: true }),
    onMutate: () => setError(null),
    onError: (e) => setError(adminErrorMessage(e)),
    onSuccess: (next) => {
      qc.setQueryData(ak.settings, next);
      void qc.invalidateQueries({ queryKey: qk.meta });
      toast.success({ title: "Settings saved" });
    },
  });

  const addDomains = () => {
    const { added, invalid } = parseDomains(domainText, form.allowedEmailDomains);
    if (added.length) set("allowedEmailDomains", [...form.allowedEmailDomains, ...added]);
    setDomainError(invalid.length ? `Not a domain: ${invalid.join(", ")}` : null);
    setDomainText(invalid.join(" "));
  };

  const f = (key: keyof SettingsForm, label: ReactNode, control: ReactNode, opts: { hint?: ReactNode; optional?: boolean } = {}) => (
    <Field label={label} htmlFor={`${id}-${key}`} error={errs[key]} hint={opts.hint} optional={opts.optional}>
      {control}
    </Field>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty.length) save.mutate();
      }}
      data-testid="settings-form"
    >
      <AdminSection title="General" id="general">
        <div className="grid max-w-2xl gap-4">
          {f("appName", "App name", <Input id={`${id}-appName`} value={form.appName} maxLength={60} onChange={(e) => set("appName", e.target.value)} data-testid="settings-app-name" />, { hint: "Shown in the header, page titles and emails." })}
          {f("tagline", "Tagline", <Input id={`${id}-tagline`} value={form.tagline} maxLength={160} onChange={(e) => set("tagline", e.target.value)} data-testid="settings-tagline" />, { optional: true })}
          {f("supportEmail", "Support email", <Input id={`${id}-supportEmail`} type="email" value={form.supportEmail} maxLength={200} placeholder="support@example.com" onChange={(e) => set("supportEmail", e.target.value)} data-testid="settings-support-email" />, { optional: true, hint: "Where developers can write for help." })}
          {f(
            "gatewayBaseUrl",
            "Gateway base URL",
            <Input id={`${id}-gatewayBaseUrl`} value={form.gatewayBaseUrl} maxLength={300} placeholder="https://api.example.com/v1" onChange={(e) => set("gatewayBaseUrl", e.target.value)} className="font-mono" data-testid="settings-gateway-url" />,
            { hint: "The address developers put in their SDK, including /v1. Shown in the console and the docs." },
          )}
          {f(
            "minSupportedVersion",
            "Minimum app version",
            <Input id={`${id}-minSupportedVersion`} value={form.minSupportedVersion} placeholder="1.4.0" onChange={(e) => set("minSupportedVersion", e.target.value)} className="w-40 font-mono" data-testid="settings-min-version" />,
            { optional: true, hint: "Older mobile apps are asked to update. Empty allows every version." },
          )}
        </div>
      </AdminSection>

      <AdminSection title="Sign-up" id="signup">
        <div className="grid max-w-2xl gap-4">
          <Field label="Who can create an account" htmlFor={`${id}-reg`}>
            <Select
              id={`${id}-reg`}
              value={form.registration}
              onValueChange={(v) => set("registration", v as AppSettings["registration"])}
              options={[
                { value: "OPEN", label: "Anyone" },
                { value: "INVITE_ONLY", label: "Only people with an allowed email domain" },
                { value: "CLOSED", label: "No one: sign-up is closed" },
              ]}
              data-testid="settings-registration"
            />
          </Field>
          <Field
            label="Allowed email domains"
            htmlFor={`${id}-domains`}
            optional={form.registration !== "INVITE_ONLY"}
            error={domainError ?? errs.allowedEmailDomains}
            hint={form.registration === "INVITE_ONLY" ? "Only addresses at these domains can sign up." : "Used when sign-up is limited to allowed domains."}
          >
            <div className="flex gap-2">
              <Input
                id={`${id}-domains`}
                value={domainText}
                placeholder="example.com"
                onChange={(e) => setDomainText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addDomains();
                  }
                }}
                data-testid="settings-domain-input"
              />
              <Button type="button" variant="outline" onClick={addDomains} disabled={!domainText.trim()} data-testid="settings-domain-add">
                Add
              </Button>
            </div>
          </Field>
          {form.allowedEmailDomains.length ? (
            <ul className="divide-y divide-border border-y border-border" aria-label="Allowed email domains" data-testid="settings-domains">
              {form.allowedEmailDomains.map((d) => (
                <li key={d} className="flex items-center justify-between gap-3 py-2 text-[14px]">
                  <span className="min-w-0 break-all font-mono text-[13px]">{d}</span>
                  <button
                    type="button"
                    onClick={() => set("allowedEmailDomains", form.allowedEmailDomains.filter((x) => x !== d))}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove ${d}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {f("signupCredit", "Sign-up credit", <UnitInput id={`${id}-signupCredit`} value={form.signupCredit} onChange={(v) => set("signupCredit", v)} unit="USD" testId="settings-signup-credit" />, {
            hint: "Free credit every new account gets once its email is verified. 0 gives none.",
          })}
        </div>
      </AdminSection>

      <AdminSection title="Pricing" id="pricing">
        <div className="grid max-w-2xl gap-4">
          {f("defaultMargin", "Default margin", <UnitInput id={`${id}-defaultMargin`} value={form.defaultMargin} onChange={(v) => set("defaultMargin", v)} unit="%" testId="settings-default-margin" />, {
            hint: "Added on top of the route cost when no key, account or model sets its own margin. 0 sells at cost.",
          })}
        </div>
      </AdminSection>

      <AdminSection title="Top-ups" id="billing">
        <div className="grid max-w-2xl gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {f("tax", "Tax", <UnitInput id={`${id}-tax`} value={form.tax} onChange={(v) => set("tax", v)} unit="%" testId="settings-tax" />, { hint: "Added on top of a top-up. 0 adds none." })}
            {f("taxLabel", "Tax label", <Input id={`${id}-taxLabel`} value={form.taxLabel} maxLength={30} onChange={(e) => set("taxLabel", e.target.value)} className="w-40" data-testid="settings-tax-label" />, { hint: "On receipts, such as GST or VAT." })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {f("usdMin", "Smallest top-up in USD", <UnitInput id={`${id}-usdMin`} value={form.usdMin} onChange={(v) => set("usdMin", v)} unit="USD" testId="settings-usd-min" />)}
            {f("usdMax", "Largest top-up in USD", <UnitInput id={`${id}-usdMax`} value={form.usdMax} onChange={(v) => set("usdMax", v)} unit="USD" testId="settings-usd-max" />)}
            {f("inrMin", "Smallest top-up in INR", <UnitInput id={`${id}-inrMin`} value={form.inrMin} onChange={(v) => set("inrMin", v)} unit="INR" testId="settings-inr-min" />)}
            {f("inrMax", "Largest top-up in INR", <UnitInput id={`${id}-inrMax`} value={form.inrMax} onChange={(v) => set("inrMax", v)} unit="INR" testId="settings-inr-max" />)}
          </div>
          {f("lowBalance", "Low balance email", <UnitInput id={`${id}-lowBalance`} value={form.lowBalance} onChange={(v) => set("lowBalance", v)} unit="USD" testId="settings-low-balance" />, {
            hint: "Email the account when its available balance drops below this. 0 turns it off.",
          })}
        </div>
      </AdminSection>

      <AdminSection title="Data" id="data">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          {f(
            "bodyRetentionDays",
            "Keep request bodies",
            <UnitInput id={`${id}-bodyRetentionDays`} value={form.bodyRetentionDays} onChange={(v) => set("bodyRetentionDays", v)} unit="days" inputMode="numeric" testId="settings-body-retention" />,
            { hint: "Only for keys that log bodies. 1 to 90 days." },
          )}
          {f(
            "requestRetentionDays",
            "Keep request rows",
            <UnitInput id={`${id}-requestRetentionDays`} value={form.requestRetentionDays} onChange={(v) => set("requestRetentionDays", v)} unit="days" inputMode="numeric" placeholder="Forever" testId="settings-request-retention" />,
            { optional: true, hint: "Usage metadata. Empty keeps it forever; otherwise 30 to 3,650 days." },
          )}
        </div>
      </AdminSection>

      {dirty.length || error ? (
        <div className="sticky bottom-0 z-30 -mx-4 mt-8 border-t border-border bg-background/90 backdrop-blur-xl sm:-mx-6" data-testid="settings-save-bar">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <p className="min-w-0 text-[13.5px]" aria-live="polite">
              {error ? (
                <span role="alert" className="font-medium text-danger">
                  {error}
                </span>
              ) : !valid ? (
                <span className="text-danger">Fix the fields marked above to save.</span>
              ) : (
                <span className="text-muted-foreground">Unsaved changes in {listJoin(dirty.map((g) => SETTINGS_GROUP_LABEL[g]))}.</span>
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setForm(toSettingsForm(saved));
                  setError(null);
                  setDomainError(null);
                  setDomainText("");
                }}
                disabled={save.isPending}
                data-testid="settings-discard"
              >
                Discard
              </Button>
              <Button type="submit" disabled={!valid || !dirty.length} loading={save.isPending} data-testid="settings-save">
                Save changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const MAIL_LABEL: Record<IntegrationStatus["mail"]["mode"], string> = { outbox: "Outbox: written to disk on the server, not sent", smtp: "SMTP", ses: "Amazon SES" };

const onOff = (on: boolean, yes = "Configured", no = "Not configured") => <StatusText tone={on ? "success" : "muted"}>{on ? yes : no}</StatusText>;

function Integrations() {
  const q = useQuery({ queryKey: ak.integrations, queryFn: () => api().admin.integrations(), staleTime: 5 * 60_000 });
  const i = q.data;
  const anyGateway = !!i && (i.payments.stripe || i.payments.razorpay || i.payments.stub);
  return (
    <AdminSection title="Integrations" id="integrations" description="What the server is set up with, from its environment. Change these in the server's configuration and restart it.">
      {q.isError && !i ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !i ? (
        <div className="max-w-2xl space-y-2" aria-busy>
          {Array.from({ length: 6 }, (_, n) => (
            <Skeleton key={n} className="h-5 w-2/3" />
          ))}
        </div>
      ) : (
        <>
          {!i.credentialsKeyConfigured ? (
            <p role="alert" className="mb-4 max-w-2xl border-y border-border py-3 text-[13.5px] text-warning" data-testid="integrations-key-warning">
              CREDENTIALS_KEY is the development default. Credentials are encrypted with a key derived from a public constant: fine on a laptop, refused in production. Set your own (openssl rand -base64 32) before adding real provider keys.
            </p>
          ) : null}
          <FactList
            className="max-w-2xl"
            items={[
              { label: "Credentials key", value: onOff(i.credentialsKeyConfigured, "Set", "Not set") },
              { label: "Email", value: MAIL_LABEL[i.mail.mode] },
              { label: "Stripe", value: onOff(i.payments.stripe) },
              { label: "Razorpay", value: onOff(i.payments.razorpay) },
              { label: "Stub payments", value: i.payments.stub ? <StatusText tone="warning">On: top-ups succeed without real money</StatusText> : onOff(false, "", "Off") },
              ...(!anyGateway ? [{ label: "Top-ups", value: <StatusText tone="warning">No payment gateway: nobody can top up</StatusText> }] : []),
              {
                label: "Exchange rate",
                value: (
                  <span>
                    1 USD = {new Intl.NumberFormat("en-IN", { maximumFractionDigits: 4 }).format(i.fx.inrPerUsd)} INR
                    <span className="text-muted-foreground">
                      {" "}
                      from {i.fx.source}
                      {i.fx.fetchedAt ? `, fetched ${fullTimestamp(i.fx.fetchedAt)}` : ", not fetched yet"}
                    </span>
                  </span>
                ),
              },
            ]}
          />
        </>
      )}
    </AdminSection>
  );
}

function FormSkeleton() {
  return (
    <div className="max-w-2xl space-y-6 border-t border-border pt-6" aria-busy>
      {Array.from({ length: 4 }, (_, n) => (
        <div key={n} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
      ))}
    </div>
  );
}
