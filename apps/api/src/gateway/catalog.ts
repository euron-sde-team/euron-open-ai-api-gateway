/**
 * The catalogue the data plane reads: enabled models, their enabled routes in priority
 * order, each route's provider and decrypted credentials. One source of truth (the
 * providers, provider_credentials, models and model_routes tables, edited in /admin),
 * loaded in one pass and cached per process for a few seconds. Admin writes clear the
 * cache in the process that made them; other processes catch up within the TTL.
 *
 * The list price of a model is its primary route's cost (the enabled route with the
 * lowest priority number) plus the margin, whichever route serves a request (ADR 0005).
 */
import type { ModelKind } from "@open-gateway/types";
import { config } from "../core/config";
import { captureError } from "../core/logger";
import { db } from "../db/kysely";
import { decryptCredential } from "../security/credentials";

export type ProviderKind = "OPENAI_COMPATIBLE" | "ANTHROPIC" | "GEMINI" | "STUB";

/** What a route costs the platform, micro-USD per million tokens or per unit. */
export interface Prices {
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  cachedMicrosPerMtok: number | null;
  unitMicros: number;
}

export interface CatalogRoute {
  id: string;
  modelId: string;
  upstreamModel: string;
  priority: number;
  timeoutMs: number;
  cost: Prices;
  provider: { id: string; kind: ProviderKind; baseUrl: string };
  credentials: { id: string; secret: string }[];
}

export interface CatalogModel {
  id: string;
  kind: ModelKind;
  displayName: string;
  description: string;
  ownedBy: string;
  aliases: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJson: boolean;
  marginBps: number | null;
  /** Usable routes (route, provider and at least one credential enabled), primary first. */
  routes: CatalogRoute[];
  /** The primary route's cost: the basis of the list price. */
  listCost: Prices;
}

export interface Catalog {
  models: CatalogModel[];
  byName: Map<string, CatalogModel>;
}

/** Where a provider kind lives when the admin left base_url empty. */
export function defaultBaseUrl(kind: ProviderKind): string | null {
  switch (kind) {
    case "ANTHROPIC":
      return "https://api.anthropic.com/v1";
    case "GEMINI":
      // Gemini's OpenAI-compatible surface: chat, embeddings and images speak the OpenAI format.
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "STUB":
      return `${config.STUBS_URL.replace(/\/$/, "")}/v1`;
    case "OPENAI_COMPATIBLE":
      return null;
  }
}

const TTL_MS = 5_000;
let cache: { at: number; value: Catalog } | null = null;
let inflight: Promise<Catalog> | null = null;

export function clearCatalogCache(): void {
  cache = null;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function load(): Promise<Catalog> {
  const [models, routes, providers, credentials] = await Promise.all([
    db.selectFrom("models").selectAll().where("enabled", "=", true).orderBy("sort_order").orderBy("id").execute(),
    db.selectFrom("model_routes").selectAll().where("enabled", "=", true).orderBy("priority").orderBy("id").execute(),
    db.selectFrom("providers").selectAll().where("enabled", "=", true).execute(),
    db.selectFrom("provider_credentials").select(["id", "provider_id", "ciphertext"]).where("enabled", "=", true).orderBy("created_at").execute(),
  ]);
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const credsByProvider = new Map<string, { id: string; secret: string }[]>();
  for (const c of credentials) {
    try {
      const list = credsByProvider.get(c.provider_id) ?? [];
      list.push({ id: c.id, secret: decryptCredential(c.ciphertext, c.id) });
      credsByProvider.set(c.provider_id, list);
    } catch (err) {
      // A credential that no longer decrypts (CREDENTIALS_KEY changed) is skipped, never fatal.
      captureError(err, { where: "catalog.decrypt", credentialId: c.id });
    }
  }
  const out: CatalogModel[] = [];
  for (const m of models) {
    const usable: CatalogRoute[] = [];
    for (const r of routes.filter((x) => x.model_id === m.id)) {
      const p = providerById.get(r.provider_id);
      if (!p) continue;
      const baseUrl = p.base_url?.trim() || defaultBaseUrl(p.kind);
      const creds = credsByProvider.get(p.id) ?? [];
      // The stub needs no key; every real provider needs at least one.
      if (!baseUrl || (!creds.length && p.kind !== "STUB")) continue;
      usable.push({
        id: r.id,
        modelId: m.id,
        upstreamModel: r.upstream_model,
        priority: r.priority,
        timeoutMs: r.timeout_ms,
        cost: { inputMicrosPerMtok: Number(r.input_micros_per_mtok), outputMicrosPerMtok: Number(r.output_micros_per_mtok), cachedMicrosPerMtok: n(r.cached_micros_per_mtok), unitMicros: Number(r.unit_micros) },
        provider: { id: p.id, kind: p.kind, baseUrl: baseUrl.replace(/\/$/, "") },
        credentials: p.kind === "STUB" && !creds.length ? [{ id: "stub", secret: "stub" }] : creds,
      });
    }
    if (!usable.length) continue;
    out.push({
      id: m.id,
      kind: m.kind,
      displayName: m.display_name,
      description: m.description,
      ownedBy: m.owned_by,
      aliases: m.aliases,
      contextWindow: m.context_window,
      maxOutputTokens: m.max_output_tokens,
      supportsTools: m.supports_tools,
      supportsVision: m.supports_vision,
      supportsJson: m.supports_json,
      marginBps: m.margin_bps,
      routes: usable,
      listCost: usable[0]!.cost,
    });
  }
  const byName = new Map<string, CatalogModel>();
  for (const m of out) {
    byName.set(m.id.toLowerCase(), m);
    for (const a of m.aliases) if (!byName.has(a.toLowerCase())) byName.set(a.toLowerCase(), m);
  }
  return { models: out, byName };
}

export async function catalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  inflight ??= load()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The model a caller asked for, by id or alias (case-insensitive), or null. */
export async function resolveModel(name: string): Promise<CatalogModel | null> {
  return (await catalog()).byName.get(name.trim().toLowerCase()) ?? null;
}

let rr = 0;
/** Round robin over a route's credentials. */
export function pickCredential(route: CatalogRoute): { id: string; secret: string } {
  rr = (rr + 1) % 1_000_000;
  return route.credentials[rr % route.credentials.length]!;
}
