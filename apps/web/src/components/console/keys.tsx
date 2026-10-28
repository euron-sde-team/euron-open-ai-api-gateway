"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { ApiKey, ApiKeyInput, CreatedApiKey } from "@open-gateway/types";
import { Button, Checkbox, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Switch, Textarea, toast } from "@open-gateway/ui";
import { api } from "@/lib/api";
import { useCatalog, useKeys } from "@/lib/console";
import { errorMessage } from "@/lib/errors";
import { useAppMeta } from "@/lib/meta";
import { formToInput, type KeyForm as Form } from "@/lib/key-form";
import { usd } from "@/lib/money";
import { qk } from "@/lib/query-keys";
import { snippet } from "@/lib/snippets";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { TimeAgo } from "@/components/common/time-ago";
import { DataTable, StatusText, type Column } from "@/components/admin/shell";
import { CodeBlock, ConsolePage, CopyButton } from "./page";

export function KeysPage() {
  const keys = useKeys();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [editing, setEditing] = useState<ApiKey | "new" | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  useEffect(() => {
    if (params.get("new") === "1") {
      setEditing("new");
      router.replace("/keys");
    }
  }, [params, router]);

  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api().keys.revoke(k.id),
    onMutate: async (k) => {
      await qc.cancelQueries({ queryKey: qk.keys });
      const before = qc.getQueryData<ApiKey[]>(qk.keys);
      qc.setQueryData<ApiKey[]>(qk.keys, (list) => list?.map((x) => (x.id === k.id ? { ...x, status: "REVOKED", revokedAt: new Date().toISOString() } : x)));
      return { before };
    },
    onError: (e, _k, ctx) => {
      qc.setQueryData(qk.keys, ctx?.before);
      toast.error(errorMessage(e));
    },
    onSuccess: () => toast.success("Key revoked. Requests with it now fail with 401."),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.keys }),
  });

  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      header: "Name",
      cell: (k) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{k.name}</span>
          <span className="block font-mono text-[12.5px] text-subtle-foreground">{k.hint}</span>
        </span>
      ),
      sortValue: (k) => k.name.toLowerCase(),
    },
    {
      key: "status",
      header: "Status",
      cell: (k) =>
        k.status === "REVOKED" ? (
          <StatusText tone="muted">Revoked</StatusText>
        ) : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? (
          <StatusText tone="warning">Expired</StatusText>
        ) : (
          <StatusText tone="success">Active</StatusText>
        ),
    },
    { key: "models", header: "Models", hideBelow: "lg", cell: (k) => <span className="text-muted-foreground">{k.allowedModels.length ? k.allowedModels.join(", ") : "All"}</span> },
    {
      key: "spend",
      header: "This month",
      align: "right",
      cell: (k) => (
        <span className="tabular-nums">
          {usd(k.spentThisMonthMicros)}
          {k.monthlyBudgetMicros ? <span className="text-subtle-foreground"> of {usd(k.monthlyBudgetMicros)}</span> : null}
        </span>
      ),
      sortValue: (k) => k.spentThisMonthMicros,
    },
    { key: "used", header: "Last used", hideBelow: "md", cell: (k) => (k.lastUsedAt ? <TimeAgo value={k.lastUsedAt} /> : <span className="text-subtle-foreground">Never</span>), sortValue: (k) => k.lastUsedAt ?? "" },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (k) =>
        k.status === "ACTIVE" ? (
          <span className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(k)} aria-label={`Edit ${k.name}`}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
              Revoke
            </Button>
          </span>
        ) : null,
    },
  ];

  return (
    <ConsolePage
      title="API keys"
      description="Every key reaches every model in the catalogue, billed to this account. Keys are shown once when created: store them in a secret manager, never in client-side code."
      actions={
        <Button onClick={() => setEditing("new")} data-testid="create-key">
          <Plus className="size-4" /> Create key
        </Button>
      }
      testId="keys-page"
      wide
    >
      <DataTable<ApiKey>
        caption="API keys"
        rows={keys.data ?? []}
        loading={keys.isLoading}
        error={keys.isError ? keys.error : undefined}
        onRetry={() => void keys.refetch()}
        rowKey={(k) => k.id}
        columns={columns}
        empty={{ title: "No keys yet", description: "Create a key to start calling models.", action: <Button onClick={() => setEditing("new")}>Create key</Button> }}
      />
      {editing ? <KeyDialog keyRow={editing === "new" ? null : editing} onClose={() => setEditing(null)} onCreated={setCreated} /> : null}
      {created ? <CreatedDialog created={created} onClose={() => setCreated(null)} /> : null}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "key"}?`}
        description="Requests with this key fail at once. This cannot be undone; create a new key to replace it."
        confirmLabel="Revoke key"
        destructive
        onConfirm={() => (revoking ? revoke.mutateAsync(revoking) : undefined)}
        testId="revoke-dialog"
      />
    </ConsolePage>
  );
}

function toForm(k: ApiKey | null): Form {
  return {
    name: k?.name ?? "",
    expiresAt: k?.expiresAt ? k.expiresAt.slice(0, 10) : "",
    allModels: !k || !k.allowedModels.length,
    models: k?.allowedModels ?? [],
    budget: k?.monthlyBudgetMicros ? String(k.monthlyBudgetMicros / 1_000_000) : "",
    rpm: k?.rpm ? String(k.rpm) : "",
    tpm: k?.tpm ? String(k.tpm) : "",
    ips: k?.ipAllowlist.join("\n") ?? "",
    logBodies: k?.logBodies ?? false,
  };
}

function KeyDialog({ keyRow, onClose, onCreated }: { keyRow: ApiKey | null; onClose: () => void; onCreated: (k: CreatedApiKey) => void }) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  const [f, setF] = useState<Form>(() => toForm(keyRow));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [advanced, setAdvanced] = useState(!!keyRow && (!!keyRow.allowedModels.length || !!keyRow.monthlyBudgetMicros || !!keyRow.rpm || !!keyRow.tpm || !!keyRow.ipAllowlist.length || !!keyRow.expiresAt));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const models = useMemo(() => catalog.data?.map((m) => m.id) ?? [], [catalog.data]);

  const save = useMutation({
    mutationFn: async (input: ApiKeyInput) => (keyRow ? api().keys.update(keyRow.id, input) : api().keys.create(input)),
    onSuccess: (k) => {
      void qc.invalidateQueries({ queryKey: qk.keys });
      if (!keyRow) onCreated(k as CreatedApiKey);
      else toast.success("Key updated. It applies to the next request.");
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = () => {
    const r = formToInput(f);
    if ("errors" in r) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    save.mutate(r.input);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="key-dialog">
        <DialogHeader>
          <DialogTitle>{keyRow ? `Edit ${keyRow.name}` : "Create an API key"}</DialogTitle>
          <DialogDescription>{keyRow ? "Changes apply to the next request made with this key." : "The secret is shown once, right after you create it."}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <Field label="Name" htmlFor="key-name" error={errors.name}>
            <Input id="key-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Production server" maxLength={80} autoFocus />
          </Field>
          {!advanced ? (
            <button type="button" className="text-[13.5px] font-medium text-primary hover:underline" onClick={() => setAdvanced(true)}>
              Limit this key (models, budget, rate, addresses, expiry)
            </button>
          ) : (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Models</legend>
                <label className="flex items-center gap-2 text-[14px]">
                  <Checkbox checked={f.allModels} onCheckedChange={(v) => set("allModels", v === true)} /> Every model, including ones added later
                </label>
                {!f.allModels ? (
                  <div className="max-h-44 space-y-1 overflow-y-auto pl-1 scrollbar-thin">
                    {models.map((m) => (
                      <label key={m} className="flex items-center gap-2 text-[13.5px]">
                        <Checkbox checked={f.models.includes(m)} onCheckedChange={(v) => set("models", v === true ? [...f.models, m] : f.models.filter((x) => x !== m))} />
                        <span className="font-mono">{m}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {errors.models ? <p className="text-xs font-medium text-danger">{errors.models}</p> : null}
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Monthly budget (USD)" htmlFor="key-budget" optional error={errors.budget} hint="Requests are refused with 402 once reached; resets on the 1st (UTC).">
                  <Input id="key-budget" inputMode="decimal" value={f.budget} onChange={(e) => set("budget", e.target.value)} placeholder="25" />
                </Field>
                <Field label="Expires" htmlFor="key-expiry" optional>
                  <Input id="key-expiry" type="date" value={f.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
                </Field>
                <Field label="Requests per minute" htmlFor="key-rpm" optional error={errors.rpm} hint="Blank uses your account's limit.">
                  <Input id="key-rpm" inputMode="numeric" value={f.rpm} onChange={(e) => set("rpm", e.target.value)} />
                </Field>
                <Field label="Tokens per minute" htmlFor="key-tpm" optional error={errors.tpm}>
                  <Input id="key-tpm" inputMode="numeric" value={f.tpm} onChange={(e) => set("tpm", e.target.value)} />
                </Field>
              </div>
              <Field label="Allowed IP addresses" htmlFor="key-ips" optional hint="One address or range per line, such as 203.0.113.7 or 203.0.113.0/24. Blank allows any address.">
                <Textarea id="key-ips" rows={3} value={f.ips} onChange={(e) => set("ips", e.target.value)} className="font-mono text-[13px]" />
              </Field>
            </>
          )}
          <label className="flex items-start justify-between gap-4 border-t border-border pt-4">
            <span>
              <span className="block text-sm font-medium">Keep request and response bodies</span>
              <span className="block text-[13px] text-muted-foreground">For debugging: bodies are kept for a few days and shown only to you on the Usage page. Off by default.</span>
            </span>
            <Switch checked={f.logBodies} onCheckedChange={(v) => set("logBodies", v)} aria-label="Keep request and response bodies" />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending} data-testid="save-key">
            {keyRow ? "Save" : "Create key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreatedDialog({ created, onClose }: { created: CreatedApiKey; onClose: () => void }) {
  const meta = useAppMeta();
  const catalog = useCatalog();
  const model = (created.allowedModels[0] ?? catalog.data?.find((m) => m.kind === "CHAT")?.id) || "your-model";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-testid="created-key-dialog">
        <DialogHeader>
          <DialogTitle>Copy your key now</DialogTitle>
          <DialogDescription>This is the only time it is shown. If you lose it, revoke it and create another.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="flex items-center gap-2 rounded-lg bg-ground-2 px-3 py-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px]" data-testid="created-key-secret">
              {created.secret}
            </code>
            <CopyButton text={created.secret} />
          </div>
          {meta.data ? <CodeBlock language="curl" code={snippet("curl", { baseUrl: meta.data.gatewayBaseUrl, keyPrefix: meta.data.keyPrefix, key: created.secret, model })} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>I have stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
