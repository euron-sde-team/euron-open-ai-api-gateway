"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Send, Square, Trash2 } from "lucide-react";
import { Button, Field, Input, NativeSelect, Switch, Textarea } from "@open-gateway/ui";
import { useCatalog, useInvalidateMoney } from "@/lib/console";
import { useAppMeta } from "@/lib/meta";
import { msLabel, usd } from "@/lib/money";
import { splitSse } from "@/lib/sse";
import { ConsolePage } from "./page";

/** The key lives in this tab only (sessionStorage): it is never sent to the console API or stored on the server. */
const KEY_SLOT = "playground.key";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Stats {
  requestId: string | null;
  latencyMs: number;
  ttfbMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function PlaygroundPage() {
  const meta = useAppMeta();
  const catalog = useCatalog();
  const invalidate = useInvalidateMoney();
  const chatModels = useMemo(() => catalog.data?.filter((m) => m.kind === "CHAT") ?? [], [catalog.data]);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [input, setInput] = useState("");
  const [stream, setStream] = useState(true);
  const [maxTokens, setMaxTokens] = useState("512");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      setKey(window.sessionStorage.getItem(KEY_SLOT) ?? "");
    } catch {
      /* storage blocked */
    }
  }, []);
  useEffect(() => {
    if (!model && chatModels[0]) setModel(chatModels[0].id);
  }, [chatModels, model]);
  const saveKey = (v: string) => {
    setKey(v);
    try {
      window.sessionStorage.setItem(KEY_SLOT, v);
    } catch {
      /* storage blocked */
    }
  };

  const price = chatModels.find((m) => m.id === model)?.price;
  const cost = stats && price && stats.inputTokens !== null ? Math.ceil(((stats.inputTokens ?? 0) * price.inputMicrosPerMtok + (stats.outputTokens ?? 0) * price.outputMicrosPerMtok) / 1_000_000) : null;

  async function send() {
    const text = input.trim();
    if (!text || !key || !model || busy) return;
    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const started = performance.now();
    let ttfb: number | null = null;
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          max_tokens: Number(maxTokens) || undefined,
          messages: [...(system.trim() ? [{ role: "system", content: system.trim() }] : []), ...history],
        }),
      });
      const requestId = res.headers.get("x-request-id");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `The gateway answered ${res.status}.`);
      }
      type Usage = { prompt_tokens?: number; completion_tokens?: number };
      let usage = null as Usage | null;
      if (!stream) {
        const body = (await res.json()) as { choices: { message: { content: string | null } }[]; usage?: Usage };
        usage = body.usage ?? null;
        setTurns([...history, { role: "assistant", content: body.choices[0]?.message.content ?? "" }]);
      } else {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let out = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { events, rest } = splitSse(buffer + decoder.decode(value, { stream: true }));
          buffer = rest;
          for (const data of events) {
            if (data === "[DONE]") continue;
            const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: Usage };
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              ttfb ??= performance.now() - started;
              out += delta;
              setTurns([...history, { role: "assistant", content: out }]);
            }
          }
        }
      }
      setStats({ requestId, latencyMs: performance.now() - started, ttfbMs: ttfb, inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null });
      void invalidate();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
        setTurns(history);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <ConsolePage title="Playground" description="Try any chat model with one of your keys. Requests are real: they are billed and appear on the Usage page." testId="playground-page" wide>
      <div className="grid gap-10 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <Field label="API key" htmlFor="pg-key" hint={<>Kept in this tab only. <Link href="/keys" className="underline">Create a key</Link> if you have none.</>}>
            <Input id="pg-key" type="password" autoComplete="off" value={key} onChange={(e) => saveKey(e.target.value.trim())} placeholder={`${meta.data?.keyPrefix ?? ""}...`} />
          </Field>
          <Field label="Model" htmlFor="pg-model">
            <NativeSelect id="pg-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {chatModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="System prompt" htmlFor="pg-system" optional>
            <Textarea id="pg-system" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a concise assistant." />
          </Field>
          <Field label="Max output tokens" htmlFor="pg-max">
            <Input id="pg-max" inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value.replace(/\D/g, ""))} className="max-w-32" />
          </Field>
          <label className="flex items-center justify-between gap-4 text-sm font-medium">
            Stream the reply
            <Switch checked={stream} onCheckedChange={setStream} aria-label="Stream the reply" />
          </label>
          {stats ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-border pt-4 text-[13px]" data-testid="pg-stats">
              <dt className="text-muted-foreground">Latency</dt>
              <dd className="text-right tabular-nums">{msLabel(stats.latencyMs)}</dd>
              {stats.ttfbMs !== null ? (
                <>
                  <dt className="text-muted-foreground">First token</dt>
                  <dd className="text-right tabular-nums">{msLabel(stats.ttfbMs)}</dd>
                </>
              ) : null}
              {stats.inputTokens !== null ? (
                <>
                  <dt className="text-muted-foreground">Tokens</dt>
                  <dd className="text-right tabular-nums">
                    {stats.inputTokens} in, {stats.outputTokens} out
                  </dd>
                </>
              ) : null}
              {cost !== null ? (
                <>
                  <dt className="text-muted-foreground">Price</dt>
                  <dd className="text-right tabular-nums">about {usd(cost)}</dd>
                </>
              ) : null}
              {stats.requestId ? (
                <dd className="col-span-2 truncate pt-1 font-mono text-[12px] text-subtle-foreground" title={stats.requestId}>
                  {stats.requestId}
                </dd>
              ) : null}
            </dl>
          ) : null}
        </aside>

        <div className="flex min-h-[60vh] flex-col">
          <div className="flex-1 space-y-6" aria-live="polite" data-testid="pg-transcript">
            {!turns.length ? <p className="py-16 text-center text-[14px] text-subtle-foreground">{key ? "Write a message to start." : "Paste one of your API keys to start."}</p> : null}
            {turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-[14.5px]" : "max-w-[90%] whitespace-pre-wrap text-[15px] leading-7"}>
                {t.content || (busy && i === turns.length - 1 ? <span className="inline-block size-2 animate-pulse rounded-full bg-subtle-foreground" aria-label="Waiting for the reply" /> : null)}
              </div>
            ))}
            {error ? (
              <p role="alert" className="text-[14px] text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <form
            className="sticky bottom-0 mt-6 flex items-end gap-2 border-t border-border bg-background pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Message"
              aria-label="Message"
              className="min-h-[52px] flex-1 resize-none"
              data-testid="pg-input"
            />
            {turns.length && !busy ? (
              <Button type="button" variant="ghost" size="sm" aria-label="Clear the conversation" onClick={() => (setTurns([]), setStats(null), setError(null))}>
                <Trash2 className="size-4" />
              </Button>
            ) : null}
            {busy ? (
              <Button type="button" variant="outline" size="sm" aria-label="Stop" onClick={() => abort.current?.abort()}>
                <Square className="size-4" />
              </Button>
            ) : (
              <Button type="submit" size="sm" aria-label="Send" disabled={!key || !input.trim() || !model} data-testid="pg-send">
                <Send className="size-4" />
              </Button>
            )}
          </form>
        </div>
      </div>
    </ConsolePage>
  );
}
