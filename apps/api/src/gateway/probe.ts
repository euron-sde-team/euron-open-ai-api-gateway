/**
 * Checking a route outside of traffic, two ways:
 *
 *   probeRoute   free: GET {base}/models with the route's credential. Proves the
 *                provider answers and the key is accepted. The health job runs it on
 *                every enabled route every few minutes and feeds the circuit breaker.
 *   testRoute    a real, tiny call (one output token, one embedding, four characters
 *                of speech) through the route, from the admin's Test button. Images and
 *                transcription fall back to the free probe: there is no tiny version.
 *
 * Both build the route straight from the database, so a disabled route or model can be
 * tested before it is switched on.
 */
import type { ModelKind, ModelTestResult } from "@open-gateway/types";
import { db } from "../db/kysely";
import { decryptCredential } from "../security/credentials";
import { defaultBaseUrl, type CatalogRoute } from "./catalog";
import { ANTHROPIC_VERSION, callUpstream, UpstreamError } from "./upstream";

export async function loadRoute(routeId: string): Promise<{ route: CatalogRoute; kind: ModelKind } | null> {
  const r = await db
    .selectFrom("model_routes as r")
    .innerJoin("models as m", "m.id", "r.model_id")
    .innerJoin("providers as p", "p.id", "r.provider_id")
    .select(["r.id", "r.model_id", "r.upstream_model", "r.priority", "r.timeout_ms", "r.input_micros_per_mtok", "r.output_micros_per_mtok", "r.cached_micros_per_mtok", "r.unit_micros", "m.kind", "p.id as provider_id", "p.kind as provider_kind", "p.base_url"])
    .where("r.id", "=", routeId)
    .executeTakeFirst();
  if (!r) return null;
  const creds = await db.selectFrom("provider_credentials").select(["id", "ciphertext"]).where("provider_id", "=", r.provider_id).where("enabled", "=", true).orderBy("created_at").execute();
  const credentials = creds.flatMap((c) => {
    try {
      return [{ id: c.id, secret: decryptCredential(c.ciphertext, c.id) }];
    } catch {
      return [];
    }
  });
  const baseUrl = (r.base_url?.trim() || defaultBaseUrl(r.provider_kind) || "").replace(/\/$/, "");
  return {
    kind: r.kind,
    route: {
      id: r.id,
      modelId: r.model_id,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      timeoutMs: Math.min(r.timeout_ms, 30_000),
      cost: { inputMicrosPerMtok: Number(r.input_micros_per_mtok), outputMicrosPerMtok: Number(r.output_micros_per_mtok), cachedMicrosPerMtok: r.cached_micros_per_mtok === null ? null : Number(r.cached_micros_per_mtok), unitMicros: Number(r.unit_micros) },
      provider: { id: r.provider_id, kind: r.provider_kind, baseUrl },
      credentials: credentials.length ? credentials : r.provider_kind === "STUB" ? [{ id: "stub", secret: "stub" }] : [],
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof UpstreamError) {
    if (err.kind === "timeout") return "The provider did not answer in time";
    if (err.kind === "network") return "The provider could not be reached";
    if (err.status === 401 || err.status === 403) return `The provider refused the credential (${err.status})`;
    if (err.status === 404) return "The provider does not know this model or endpoint (404)";
    if (err.status === 429) return "The provider is rate limiting this credential (429)";
    return `The provider answered ${err.status}`;
  }
  return "The check failed";
}

/** Free reachability and credential check. */
export async function probeRoute(route: CatalogRoute): Promise<ModelTestResult> {
  const started = Date.now();
  if (!route.provider.baseUrl) return { ok: false, latencyMs: 0, message: "The provider has no base URL" };
  const cred = route.credentials[0];
  if (!cred) return { ok: false, latencyMs: 0, message: "The provider has no enabled credential" };
  const headers: Record<string, string> = route.provider.kind === "ANTHROPIC" ? { "x-api-key": cred.secret, "anthropic-version": ANTHROPIC_VERSION } : { Authorization: `Bearer ${cred.secret}` };
  try {
    const res = await fetch(`${route.provider.baseUrl}/models`, { headers, signal: AbortSignal.timeout(Math.min(route.timeoutMs, 15_000)) });
    await res.body?.cancel().catch(() => undefined);
    const latencyMs = Date.now() - started;
    if (res.ok) return { ok: true, latencyMs, message: "The provider answered and accepted the credential" };
    return { ok: false, latencyMs, message: describe(new UpstreamError(res.status, res.status >= 500 || res.status === 429, "http", route.provider.id)) };
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    return { ok: false, latencyMs: Date.now() - started, message: describe(new UpstreamError(null, true, timedOut ? "timeout" : "network", route.provider.id)) };
  }
}

/** A real, minimal call through the route. */
export async function testRoute(route: CatalogRoute, kind: ModelKind): Promise<ModelTestResult> {
  if (!route.credentials.length) return { ok: false, latencyMs: 0, message: "The provider has no enabled credential" };
  const started = Date.now();
  try {
    if (kind === "CHAT") {
      if (route.provider.kind === "ANTHROPIC") await callUpstream(route, "/messages", { model: route.upstreamModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }).then((r) => r.json());
      else await callUpstream(route, "/chat/completions", { model: route.upstreamModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }).then((r) => r.json());
    } else if (kind === "EMBEDDING") {
      await callUpstream(route, "/embeddings", { model: route.upstreamModel, input: "ping" }).then((r) => r.json());
    } else if (kind === "SPEECH") {
      await callUpstream(route, "/audio/speech", { model: route.upstreamModel, input: "ping", voice: "alloy" }).then((r) => r.arrayBuffer());
    } else {
      const probe = await probeRoute(route);
      return { ...probe, message: probe.ok ? `${probe.message}; no test call is made for ${kind.toLowerCase()} models` : probe.message };
    }
    return { ok: true, latencyMs: Date.now() - started, message: `The model answered through ${route.provider.id}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, message: describe(err) };
  }
}
