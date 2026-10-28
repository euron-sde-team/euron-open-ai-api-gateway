/**
 * A starter catalogue: the providers most people start with and a few models each, so a
 * new install needs only credentials. Every real model starts DISABLED: add the
 * provider's API key in /admin/providers, check the route's cost against the provider's
 * current price list (the numbers below are starting points, not a source of truth),
 * press Test, then enable the model. Model ids change often; everything here is data,
 * edited in /admin.
 *
 * Outside production the local stub providers are added too, with enabled models for
 * every endpoint, so the whole gateway (streaming, translation, failover, billing) works
 * with no keys:
 *
 *   stub-chat       OpenAI-compatible chat (alias "stub")
 *   stub-claude     served by the Anthropic-format stub: exercises translation both ways
 *   stub-failover   primary route answers 503, the second route serves: exercises failover
 *   stub-embed, stub-image, stub-tts, stub-whisper   the other endpoints
 *
 * Costs are micro-USD per million tokens, or per image, per million characters (speech)
 * and per minute (transcription).
 */
import type { ModelKind } from "@open-gateway/types";
import { config } from "../core/config";
import { newId } from "../core/ids";
import type { Executor } from "../db/kysely";
import type { ProviderKind } from "../gateway/catalog";
import { encryptCredential, last4 } from "../security/credentials";

interface StarterRoute {
  provider: string;
  upstream: string;
  priority?: number;
  input?: number;
  output?: number;
  cached?: number | null;
  unit?: number;
}

interface StarterModel {
  id: string;
  kind: ModelKind;
  name: string;
  description: string;
  ownedBy: string;
  aliases?: string[];
  context?: number;
  maxOut?: number;
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  routes: StarterRoute[];
}

interface StarterProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string | null;
  /** Stub providers only: a placeholder credential so the route is usable. */
  stubSecret?: string;
}

const PROVIDERS: StarterProvider[] = [
  { id: "openai", kind: "OPENAI_COMPATIBLE", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", kind: "ANTHROPIC", name: "Anthropic", baseUrl: null },
  { id: "gemini", kind: "GEMINI", name: "Google Gemini", baseUrl: null },
  { id: "groq", kind: "OPENAI_COMPATIBLE", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
];

const MODELS: StarterModel[] = [
  { id: "gpt-5.4", kind: "CHAT", name: "GPT-5.4", description: "OpenAI's general model.", ownedBy: "openai", context: 400_000, maxOut: 128_000, tools: true, vision: true, json: true, routes: [{ provider: "openai", upstream: "gpt-5.4", input: 1_250_000, output: 10_000_000, cached: 125_000 }] },
  { id: "gpt-5.4-mini", kind: "CHAT", name: "GPT-5.4 mini", description: "Fast and inexpensive.", ownedBy: "openai", context: 400_000, maxOut: 128_000, tools: true, vision: true, json: true, routes: [{ provider: "openai", upstream: "gpt-5.4-mini", input: 250_000, output: 2_000_000, cached: 25_000 }] },
  { id: "claude-sonnet-5-5", kind: "CHAT", name: "Claude Sonnet 5.5", description: "Anthropic's balanced model.", ownedBy: "anthropic", context: 200_000, maxOut: 64_000, tools: true, vision: true, json: true, routes: [{ provider: "anthropic", upstream: "claude-sonnet-5-5", input: 3_000_000, output: 15_000_000, cached: 300_000 }] },
  { id: "claude-haiku-5-5", kind: "CHAT", name: "Claude Haiku 5.5", description: "Anthropic's fastest model.", ownedBy: "anthropic", context: 200_000, maxOut: 64_000, tools: true, vision: true, json: true, routes: [{ provider: "anthropic", upstream: "claude-haiku-5-5", input: 1_000_000, output: 5_000_000, cached: 100_000 }] },
  { id: "gemini-3.5-flash", kind: "CHAT", name: "Gemini 3.5 Flash", description: "Google's fast multimodal model.", ownedBy: "google", context: 1_000_000, maxOut: 65_000, tools: true, vision: true, json: true, routes: [{ provider: "gemini", upstream: "gemini-3.5-flash", input: 300_000, output: 2_500_000 }] },
  { id: "llama-3.3-70b", kind: "CHAT", name: "Llama 3.3 70B", description: "Open weights, served by Groq.", ownedBy: "meta", context: 128_000, maxOut: 32_000, tools: true, json: true, routes: [{ provider: "groq", upstream: "llama-3.3-70b-versatile", input: 590_000, output: 790_000 }] },
  { id: "text-embedding-3-small", kind: "EMBEDDING", name: "Text embedding 3 small", description: "1536-dimension embeddings.", ownedBy: "openai", context: 8_191, routes: [{ provider: "openai", upstream: "text-embedding-3-small", input: 20_000 }] },
  { id: "gpt-image-1", kind: "IMAGE", name: "GPT Image 1", description: "Image generation, priced per image.", ownedBy: "openai", routes: [{ provider: "openai", upstream: "gpt-image-1", unit: 40_000 }] },
  { id: "tts-1", kind: "SPEECH", name: "TTS 1", description: "Text to speech, priced per million characters.", ownedBy: "openai", routes: [{ provider: "openai", upstream: "tts-1", unit: 15_000_000 }] },
  { id: "whisper-1", kind: "TRANSCRIPTION", name: "Whisper", description: "Speech to text, priced per minute.", ownedBy: "openai", routes: [{ provider: "openai", upstream: "whisper-1", unit: 6_000 }] },
];

const STUB_PROVIDERS: StarterProvider[] = [
  { id: "stub", kind: "STUB", name: "Local stub (OpenAI format)", baseUrl: null },
  { id: "stub-anthropic", kind: "ANTHROPIC", name: "Local stub (Anthropic format)", baseUrl: `${config.STUBS_URL.replace(/\/$/, "")}/anthropic/v1`, stubSecret: "sk-ant-local-stub" },
];

const STUB_MODELS: StarterModel[] = [
  { id: "stub-chat", kind: "CHAT", name: "Stub chat", description: "Deterministic local replies with exact usage.", ownedBy: "", aliases: ["stub"], context: 128_000, maxOut: 4_096, tools: true, json: true, routes: [{ provider: "stub", upstream: "stub-chat", input: 500_000, output: 1_500_000, cached: 250_000 }] },
  { id: "stub-claude", kind: "CHAT", name: "Stub Claude", description: "Served in the Anthropic format: translated for /v1/chat/completions.", ownedBy: "", context: 200_000, maxOut: 4_096, tools: true, routes: [{ provider: "stub-anthropic", upstream: "stub-claude", input: 800_000, output: 4_000_000 }] },
  {
    id: "stub-failover",
    kind: "CHAT",
    name: "Stub failover",
    description: "The primary route answers 503; the second serves the request.",
    ownedBy: "",
    context: 128_000,
    maxOut: 4_096,
    routes: [
      { provider: "stub", upstream: "fail-503", priority: 1, input: 500_000, output: 1_500_000 },
      { provider: "stub", upstream: "stub-chat", priority: 2, input: 500_000, output: 1_500_000 },
    ],
  },
  { id: "stub-embed", kind: "EMBEDDING", name: "Stub embeddings", description: "Eight-dimension vectors.", ownedBy: "", context: 8_191, routes: [{ provider: "stub", upstream: "stub-embed", input: 20_000 }] },
  { id: "stub-image", kind: "IMAGE", name: "Stub images", description: "One transparent pixel per image.", ownedBy: "", routes: [{ provider: "stub", upstream: "stub-image", unit: 40_000 }] },
  { id: "stub-tts", kind: "SPEECH", name: "Stub speech", description: "Silent bytes, priced per million characters.", ownedBy: "", routes: [{ provider: "stub", upstream: "stub-tts", unit: 15_000_000 }] },
  { id: "stub-whisper", kind: "TRANSCRIPTION", name: "Stub transcription", description: "One minute per 100 KB of audio.", ownedBy: "", routes: [{ provider: "stub", upstream: "stub-whisper", unit: 6_000 }] },
];

async function insert(exec: Executor, providers: StarterProvider[], models: StarterModel[], enabled: boolean, order: { n: number }): Promise<void> {
  for (const p of providers) {
    const created = await exec.insertInto("providers").values({ id: p.id, kind: p.kind, display_name: p.name, base_url: p.baseUrl, enabled: true }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
    if (created && p.stubSecret) {
      const credId = newId();
      await exec.insertInto("provider_credentials").values({ id: credId, provider_id: p.id, label: "Local stub", ciphertext: encryptCredential(p.stubSecret, credId), last4: last4(p.stubSecret) }).execute();
    }
  }
  for (const m of models) {
    const created = await exec
      .insertInto("models")
      .values({
        id: m.id,
        kind: m.kind,
        display_name: m.name,
        description: m.description,
        owned_by: m.ownedBy,
        aliases: m.aliases ?? [],
        context_window: m.context ?? null,
        max_output_tokens: m.maxOut ?? null,
        supports_tools: m.tools ?? false,
        supports_vision: m.vision ?? false,
        supports_json: m.json ?? false,
        enabled,
        sort_order: order.n++,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!created) continue;
    for (const r of m.routes) {
      await exec
        .insertInto("model_routes")
        .values({ id: newId(), model_id: m.id, provider_id: r.provider, upstream_model: r.upstream, priority: r.priority ?? 1, input_micros_per_mtok: r.input ?? 0, output_micros_per_mtok: r.output ?? 0, cached_micros_per_mtok: r.cached ?? null, unit_micros: r.unit ?? 0 })
        .execute();
    }
  }
}

/** Insert the starter catalogue where it is missing (existing providers and models are left alone). */
export async function ensureStarterCatalog(exec: Executor, opts: { includeStub?: boolean } = {}): Promise<void> {
  const order = { n: 0 };
  if (opts.includeStub && config.NODE_ENV !== "production") await insert(exec, STUB_PROVIDERS, STUB_MODELS, true, order);
  await insert(exec, PROVIDERS, MODELS, false, order);
}
