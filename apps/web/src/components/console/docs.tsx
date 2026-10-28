"use client";

import { useState } from "react";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { useCatalog } from "@/lib/console";
import { useAppMeta } from "@/lib/meta";
import { SNIPPET_LABEL, snippet, type SnippetLang } from "@/lib/snippets";
import { CodeBlock, ConsolePage, CopyButton, Section } from "./page";

const LANGS: SnippetLang[] = ["curl", "python", "node", "anthropic-python", "anthropic-node"];

const ENDPOINTS: [string, string][] = [
  ["POST /v1/chat/completions", "OpenAI Chat Completions: streaming, tools, JSON mode, images in messages. Works with every chat model, including Claude."],
  ["POST /v1/messages", "Anthropic Messages: streaming and tools. Works with every chat model, including OpenAI's."],
  ["POST /v1/embeddings", "Embeddings for a string or a list of strings."],
  ["POST /v1/images/generations", "Image generation, priced per image."],
  ["POST /v1/audio/speech", "Text to speech, priced per million characters. Returns audio bytes."],
  ["POST /v1/audio/transcriptions", "Speech to text from a multipart upload, priced per minute."],
  ["GET /v1/models", "The models your key may call."],
];

const ERRORS: [string, string, string][] = [
  ["400", "invalid_request_error", "The request is malformed, or the model does not support this endpoint."],
  ["401", "authentication_error", "The key is missing, wrong, revoked or expired."],
  ["402", "insufficient_balance", "Your balance cannot cover the request (code insufficient_balance), or the key reached its monthly budget (budget_exceeded). Nothing is charged."],
  ["403", "permission_error", "The key may not use this model or this IP address, or the account is restricted."],
  ["404", "not_found_error", "No such model (check the id on the Models page)."],
  ["429", "rate_limit_error", "Too many requests or tokens per minute, or too many at once. Wait for retry-after seconds."],
  ["502 / 503", "api_error, overloaded_error", "Every provider for the model failed or is paused. Nothing is charged; retry shortly."],
];

export function DocsPage() {
  const meta = useAppMeta();
  const catalog = useCatalog();
  const [lang, setLang] = useState<SnippetLang>("curl");
  const chat = catalog.data?.find((m) => m.kind === "CHAT")?.id ?? "your-model";
  const base = meta.data?.gatewayBaseUrl ?? "https://gateway.example.com/v1";
  const prefix = meta.data?.keyPrefix ?? "gw-";

  return (
    <ConsolePage title="Docs" description="The gateway speaks the OpenAI and Anthropic APIs. Keep your SDK and your code; change the base URL and the key." testId="docs-page">
      <Section title="Base URL" id="base-url">
        <div className="flex items-center gap-2 rounded-lg bg-ground-2 px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[14px]">{base}</code>
          <CopyButton text={base} />
        </div>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          Send your key as <code>Authorization: Bearer {prefix}...</code> or as <code>x-api-key</code> (what the Anthropic SDKs send). The Anthropic SDKs take the base URL without <code>/v1</code>.
        </p>
      </Section>

      <Section title="Quickstart" id="quickstart">
        <UnderlineTabs<SnippetLang> tabs={LANGS.map((l) => ({ value: l, label: SNIPPET_LABEL[l] }))} value={lang} onChange={setLang} label="Language" size="sm" />
        <CodeBlock className="mt-4" language={SNIPPET_LABEL[lang]} code={snippet(lang, { baseUrl: base, keyPrefix: prefix, model: chat })} testId="docs-snippet" />
      </Section>

      <Section title="Endpoints" id="endpoints">
        <dl className="divide-y divide-border">
          {ENDPOINTS.map(([path, what]) => (
            <div key={path} className="grid gap-1 py-3 sm:grid-cols-[260px_1fr] sm:gap-6">
              <dt className="font-mono text-[13.5px]">{path}</dt>
              <dd className="text-[14px] text-muted-foreground">{what}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Billing" id="billing">
        <div className="space-y-3 text-[14.5px] leading-7 text-muted-foreground">
          <p>Each request is priced from the tokens (or images, characters, minutes) the provider reports, at the prices on the Models page, and paid from your balance. The price and the token counts of every request are on the Usage page.</p>
          <p>Before calling a provider the gateway holds the most a request could cost (its input plus max_tokens of output) and releases the rest when it finishes, so parallel requests can never spend more than you have. Set max_tokens to keep that hold small.</p>
          <p>A stream that ends early without usage is billed from an estimate and marked as estimated. Failed requests are free.</p>
        </div>
      </Section>

      <Section title="Errors" id="errors" description="Errors use the OpenAI shape on OpenAI endpoints and the Anthropic shape on /v1/messages, with the same codes.">
        <table className="w-full text-left text-[13.5px]">
          <thead className="text-subtle-foreground">
            <tr className="border-b border-border">
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map(([status, type, meaning]) => (
              <tr key={status} className="border-b border-border align-top">
                <td className="py-2.5 pr-4 tabular-nums">{status}</td>
                <td className="py-2.5 pr-4 font-mono text-[12.5px]">{type}</td>
                <td className="py-2.5 text-muted-foreground">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Reliability" id="reliability">
        <p className="text-[14.5px] leading-7 text-muted-foreground">A model can be served by several providers. When one fails (a timeout, a 429 or a 5xx) before any of the reply was sent, the gateway retries the next one, and a provider that keeps failing is paused for a short while. You pay the model&rsquo;s listed price whichever provider served it. Every response carries an x-request-id you can look up on the Usage page.</p>
      </Section>
    </ConsolePage>
  );
}
