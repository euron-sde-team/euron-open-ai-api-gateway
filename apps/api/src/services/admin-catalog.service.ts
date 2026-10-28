/**
 * The catalogue in /admin: providers and their encrypted credentials, models, routes and
 * margins, route tests, health and circuits. Every write is audited in its transaction
 * and clears the catalogue cache of this process (others follow within its TTL).
 *
 * Invariants:
 *   - a credential's secret is encrypted on arrival (AAD = the credential id) and only
 *     its label and last four characters are ever returned;
 *   - an enabled model's primary route (the first usable one) is always priced:
 *     enabling a model without one, or a change that would leave an enabled model with
 *     a free or missing primary, is refused (MODEL_UNPRICED). Billing a model at zero by
 *     accident is not possible.
 */
import type { AdminModel, AdminProvider, HealthRow, ModelKind, ModelRoute, ModelTestResult } from "@open-gateway/types";
import { sql } from "kysely";
import { isProd } from "../core/config";
import { requireAdmin, type Actor, type RequestMeta } from "../core/context";
import { withTransaction } from "../core/effects";
import { badRequest, conflict, notFound } from "../core/errors";
import { newId } from "../core/ids";
import { db, type Executor } from "../db/kysely";
import { circuitState, forceCircuit } from "../gateway/breaker";
import { clearCatalogCache, type ProviderKind } from "../gateway/catalog";
import { effectiveMargin, priceList } from "../gateway/pricing";
import { loadRoute, testRoute as runTest } from "../gateway/probe";
import { encryptCredential, last4 } from "../security/credentials";
import { audit } from "./audit.service";
import { getSettings } from "./settings.service";

// ─── Providers ──────────────────────────────────────────────────────────────

export interface ProviderInput {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
}

export async function listProviders(actor: Actor): Promise<AdminProvider[]> {
  requireAdmin(actor);
  const [providers, creds, routes] = await Promise.all([
    db.selectFrom("providers").selectAll().orderBy("id").execute(),
    db.selectFrom("provider_credentials").select(["id", "provider_id", "label", "last4", "enabled", "disabled_reason", "created_at"]).orderBy("created_at").execute(),
    db.selectFrom("model_routes").select(["provider_id", (eb) => eb.fn.countAll<string>().as("n")]).groupBy("provider_id").execute(),
  ]);
  const routeCount = new Map(routes.map((r) => [r.provider_id, Number(r.n)]));
  return providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    displayName: p.display_name,
    baseUrl: p.base_url,
    enabled: p.enabled,
    credentials: creds.filter((c) => c.provider_id === p.id).map((c) => ({ id: c.id, label: c.label, last4: c.last4, enabled: c.enabled, disabledReason: c.disabled_reason, createdAt: c.created_at.toISOString() })),
    routeCount: routeCount.get(p.id) ?? 0,
  }));
}

function checkBaseUrl(kind: ProviderKind, baseUrl: string | null): void {
  if (kind === "OPENAI_COMPATIBLE" && !baseUrl) throw badRequest("An OpenAI-compatible provider needs a base URL (for example https://api.openai.com/v1)", "BASE_URL_REQUIRED");
  if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw badRequest("The base URL must be an http(s) URL", "BASE_URL_INVALID");
}

export async function saveProvider(actor: Actor, input: ProviderInput, isNew: boolean, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  if (input.kind === "STUB" && isProd) throw badRequest("Stub providers exist for development only", "STUB_NOT_ALLOWED");
  checkBaseUrl(input.kind, input.baseUrl);
  await withTransaction(async (trx) => {
    const exists = await trx.selectFrom("providers").select("id").where("id", "=", input.id).executeTakeFirst();
    if (isNew && exists) throw conflict("A provider with that id exists", "PROVIDER_EXISTS");
    if (!isNew && !exists) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    const values = { kind: input.kind, display_name: input.displayName, base_url: input.baseUrl?.replace(/\/$/, "") || null, enabled: input.enabled };
    if (isNew) await trx.insertInto("providers").values({ id: input.id, ...values }).execute();
    else await trx.updateTable("providers").set({ ...values, updated_at: new Date() }).where("id", "=", input.id).execute();
    if (!input.enabled) await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: isNew ? "provider.created" : "provider.updated", entityType: "provider", entityId: input.id, ip: meta.ip, data: { ...values } }, trx);
  });
  clearCatalogCache();
  return listProviders(actor);
}

export async function deleteProvider(actor: Actor, id: string, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const gone = await trx.deleteFrom("providers").where("id", "=", id).returning("id").executeTakeFirst();
    if (!gone) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: "provider.deleted", entityType: "provider", entityId: id, ip: meta.ip }, trx);
  });
  clearCatalogCache();
  return listProviders(actor);
}

export async function addCredential(actor: Actor, providerId: string, input: { label: string; secret: string }, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  const secret = input.secret.trim();
  if (secret.length < 8) throw badRequest("That does not look like an API key", "SECRET_INVALID");
  await withTransaction(async (trx) => {
    if (!(await trx.selectFrom("providers").select("id").where("id", "=", providerId).executeTakeFirst())) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    const id = newId();
    await trx.insertInto("provider_credentials").values({ id, provider_id: providerId, label: input.label, ciphertext: encryptCredential(secret, id), last4: last4(secret) }).execute();
    await audit({ actorId: actor.id, action: "credential.added", entityType: "provider", entityId: providerId, ip: meta.ip, data: { credentialId: id, label: input.label } }, trx);
  });
  clearCatalogCache();
  return listProviders(actor);
}

export async function setCredentialEnabled(actor: Actor, providerId: string, credentialId: string, enabled: boolean, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const row = await trx
      .updateTable("provider_credentials")
      .set({ enabled, disabled_reason: enabled ? null : "Disabled by an admin" })
      .where("id", "=", credentialId)
      .where("provider_id", "=", providerId)
      .returning("id")
      .executeTakeFirst();
    if (!row) throw notFound("Credential not found", "CREDENTIAL_NOT_FOUND");
    if (!enabled) await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: enabled ? "credential.enabled" : "credential.disabled", entityType: "provider", entityId: providerId, ip: meta.ip, data: { credentialId } }, trx);
  });
  clearCatalogCache();
  return listProviders(actor);
}

export async function deleteCredential(actor: Actor, providerId: string, credentialId: string, meta: RequestMeta): Promise<AdminProvider[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const row = await trx.deleteFrom("provider_credentials").where("id", "=", credentialId).where("provider_id", "=", providerId).returning("id").executeTakeFirst();
    if (!row) throw notFound("Credential not found", "CREDENTIAL_NOT_FOUND");
    await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: "credential.deleted", entityType: "provider", entityId: providerId, ip: meta.ip, data: { credentialId } }, trx);
  });
  clearCatalogCache();
  return listProviders(actor);
}

// ─── Models and routes ──────────────────────────────────────────────────────

/** A route is priced when the dimension its model bills on costs more than zero. */
const pricedSql = sql<boolean>`CASE m.kind
  WHEN 'CHAT' THEN (r.input_micros_per_mtok > 0 OR r.output_micros_per_mtok > 0)
  WHEN 'EMBEDDING' THEN r.input_micros_per_mtok > 0
  ELSE r.unit_micros > 0 END`;

/**
 * Every enabled model's primary route is usable and priced. The primary route is the one
 * the data plane prices the model from: the first usable route (route and provider
 * enabled, and an enabled credential unless the provider is the stub) by priority, then
 * id, the same order catalog.ts uses. A priced backup behind a free primary is not
 * enough: callers would be charged the primary's zero. Run inside the transaction of any
 * change that could break it.
 */
async function assertEnabledModelsPriced(trx: Executor): Promise<void> {
  const rows = await sql<{ id: string; priced: boolean | null }>`
    SELECT m.id, p.priced
    FROM models m
    LEFT JOIN LATERAL (
      SELECT ${pricedSql} AS priced
      FROM model_routes r
      JOIN providers pr ON pr.id = r.provider_id
      WHERE r.model_id = m.id AND r.enabled AND pr.enabled
        AND (pr.kind = 'STUB' OR EXISTS (SELECT 1 FROM provider_credentials c WHERE c.provider_id = pr.id AND c.enabled))
      ORDER BY r.priority, r.id
      LIMIT 1
    ) p ON true
    WHERE m.enabled AND p.priced IS NOT TRUE
    LIMIT 5`.execute(trx);
  const broken = rows.rows;
  if (broken.length) throw conflict(`An enabled model needs a usable, priced primary route (the first enabled route, by priority, on an enabled provider with a credential): ${broken.map((b) => b.id).join(", ")}. Price that route, reorder the routes, or disable the model first.`, "MODEL_UNPRICED", { models: broken.map((b) => b.id) });
}

export async function listModels(actor: Actor): Promise<AdminModel[]> {
  requireAdmin(actor);
  const [models, routes, checks, s] = await Promise.all([
    db.selectFrom("models").selectAll().orderBy("sort_order").orderBy("id").execute(),
    db.selectFrom("model_routes").selectAll().orderBy("priority").orderBy("id").execute(),
    db
      .selectFrom("health_checks")
      .distinctOn("route_id")
      .select(["route_id", "ok", "latency_ms", "error", "checked_at"])
      .orderBy("route_id")
      .orderBy("checked_at", "desc")
      .execute(),
    getSettings(),
  ]);
  // Which providers can serve (enabled, and a credential unless the stub): the data plane prices from the first route on one.
  const providers = await db
    .selectFrom("providers as p")
    .select(["p.id", sql<boolean>`p.enabled AND (p.kind = 'STUB' OR EXISTS (SELECT 1 FROM provider_credentials c WHERE c.provider_id = p.id AND c.enabled))`.as("usable")])
    .execute();
  const usableProvider = new Set(providers.filter((p) => p.usable).map((p) => p.id));
  const lastCheck = new Map(checks.map((c) => [c.route_id, c]));
  const circuits = new Map(await Promise.all(routes.map(async (r) => [r.id, await circuitState(r.id)] as const)));
  return models.map((m) => {
    const mine: ModelRoute[] = routes
      .filter((r) => r.model_id === m.id)
      .map((r) => {
        const c = lastCheck.get(r.id);
        return {
          id: r.id,
          providerId: r.provider_id,
          upstreamModel: r.upstream_model,
          priority: r.priority,
          timeoutMs: r.timeout_ms,
          inputMicrosPerMtok: Number(r.input_micros_per_mtok),
          outputMicrosPerMtok: Number(r.output_micros_per_mtok),
          cachedMicrosPerMtok: r.cached_micros_per_mtok === null ? null : Number(r.cached_micros_per_mtok),
          unitMicros: Number(r.unit_micros),
          enabled: r.enabled,
          circuit: circuits.get(r.id) ?? "closed",
          lastCheck: c ? { ok: c.ok, latencyMs: c.latency_ms, error: c.error, checkedAt: c.checked_at.toISOString() } : null,
        };
      });
    const primary = mine.find((r) => r.enabled && usableProvider.has(r.providerId));
    const margin = effectiveMargin(null, null, m.margin_bps, s.defaultMarginBps);
    return {
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
      effectiveMarginBps: margin,
      price: primary ? priceList({ inputMicrosPerMtok: primary.inputMicrosPerMtok, outputMicrosPerMtok: primary.outputMicrosPerMtok, cachedMicrosPerMtok: primary.cachedMicrosPerMtok, unitMicros: primary.unitMicros }, margin) : null,
      enabled: m.enabled,
      sortOrder: m.sort_order,
      routes: mine,
    };
  });
}

export interface ModelInput {
  kind: ModelKind;
  displayName: string;
  description?: string;
  ownedBy?: string;
  aliases?: string[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsJson?: boolean;
  marginBps?: number | null;
  enabled?: boolean;
  sortOrder?: number;
}

/** Aliases may not shadow another model's id or alias. */
async function assertAliasesFree(trx: Executor, id: string, aliases: string[]): Promise<void> {
  const names = [id, ...aliases].map((a) => a.toLowerCase());
  const clash = await trx
    .selectFrom("models")
    .select("id")
    .where("id", "<>", id)
    .where((eb) => eb.or([eb(sql`lower(id)`, "in", names), sql<boolean>`EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = ANY(${sql.val(names)}::text[]))`]))
    .executeTakeFirst();
  if (clash) throw conflict(`That id or alias is already used by ${clash.id}`, "ALIAS_TAKEN");
}

export async function saveModel(actor: Actor, id: string, input: ModelInput, isNew: boolean, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))];
  await withTransaction(async (trx) => {
    const exists = await trx.selectFrom("models").select(["id", "kind"]).where("id", "=", id).executeTakeFirst();
    if (isNew && exists) throw conflict("A model with that id exists", "MODEL_EXISTS");
    if (!isNew && !exists) throw notFound("Model not found", "MODEL_NOT_FOUND");
    await assertAliasesFree(trx, id, aliases);
    const values = {
      kind: input.kind,
      display_name: input.displayName,
      description: input.description ?? "",
      owned_by: input.ownedBy ?? "",
      aliases,
      context_window: input.contextWindow ?? null,
      max_output_tokens: input.maxOutputTokens ?? null,
      supports_tools: input.supportsTools ?? false,
      supports_vision: input.supportsVision ?? false,
      supports_json: input.supportsJson ?? false,
      margin_bps: input.marginBps ?? null,
      enabled: input.enabled ?? false,
      sort_order: input.sortOrder ?? 0,
    };
    if (isNew) await trx.insertInto("models").values({ id, ...values }).execute();
    else await trx.updateTable("models").set({ ...values, updated_at: new Date() }).where("id", "=", id).execute();
    if (values.enabled) await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: isNew ? "model.created" : "model.updated", entityType: "model", entityId: id, ip: meta.ip, data: { enabled: values.enabled, marginBps: values.margin_bps, kind: values.kind } }, trx);
  });
  clearCatalogCache();
  return listModels(actor);
}

export async function deleteModel(actor: Actor, id: string, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const gone = await trx.deleteFrom("models").where("id", "=", id).returning("id").executeTakeFirst();
    if (!gone) throw notFound("Model not found", "MODEL_NOT_FOUND");
    await audit({ actorId: actor.id, action: "model.deleted", entityType: "model", entityId: id, ip: meta.ip }, trx);
  });
  clearCatalogCache();
  return listModels(actor);
}

export interface RouteInput {
  providerId: string;
  upstreamModel: string;
  priority: number;
  timeoutMs?: number;
  inputMicrosPerMtok: number;
  outputMicrosPerMtok: number;
  cachedMicrosPerMtok?: number | null;
  unitMicros?: number;
  enabled?: boolean;
}

export async function saveRoute(actor: Actor, modelId: string, routeId: string | null, input: RouteInput, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    if (!(await trx.selectFrom("models").select("id").where("id", "=", modelId).executeTakeFirst())) throw notFound("Model not found", "MODEL_NOT_FOUND");
    if (!(await trx.selectFrom("providers").select("id").where("id", "=", input.providerId).executeTakeFirst())) throw notFound("Provider not found", "PROVIDER_NOT_FOUND");
    const values = {
      provider_id: input.providerId,
      upstream_model: input.upstreamModel.trim(),
      priority: input.priority,
      timeout_ms: input.timeoutMs ?? 120_000,
      input_micros_per_mtok: input.inputMicrosPerMtok,
      output_micros_per_mtok: input.outputMicrosPerMtok,
      cached_micros_per_mtok: input.cachedMicrosPerMtok ?? null,
      unit_micros: input.unitMicros ?? 0,
      enabled: input.enabled ?? true,
    };
    const dup = await trx
      .selectFrom("model_routes")
      .select("id")
      .where("model_id", "=", modelId)
      .where("provider_id", "=", values.provider_id)
      .where("upstream_model", "=", values.upstream_model)
      .$if(!!routeId, (q) => q.where("id", "<>", routeId!))
      .executeTakeFirst();
    if (dup) throw conflict("This model already has a route to that provider model", "ROUTE_EXISTS");
    const id = routeId ?? newId();
    if (routeId) {
      const row = await trx.updateTable("model_routes").set({ ...values, updated_at: new Date() }).where("id", "=", routeId).where("model_id", "=", modelId).returning("id").executeTakeFirst();
      if (!row) throw notFound("Route not found", "ROUTE_NOT_FOUND");
    } else {
      await trx.insertInto("model_routes").values({ id, model_id: modelId, ...values }).execute();
    }
    await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: routeId ? "route.updated" : "route.created", entityType: "model", entityId: modelId, ip: meta.ip, data: { routeId: id, ...values } }, trx);
  });
  clearCatalogCache();
  return listModels(actor);
}

export async function deleteRoute(actor: Actor, modelId: string, routeId: string, meta: RequestMeta): Promise<AdminModel[]> {
  requireAdmin(actor);
  await withTransaction(async (trx) => {
    const gone = await trx.deleteFrom("model_routes").where("id", "=", routeId).where("model_id", "=", modelId).returning("id").executeTakeFirst();
    if (!gone) throw notFound("Route not found", "ROUTE_NOT_FOUND");
    await assertEnabledModelsPriced(trx);
    await audit({ actorId: actor.id, action: "route.deleted", entityType: "model", entityId: modelId, ip: meta.ip, data: { routeId } }, trx);
  });
  clearCatalogCache();
  return listModels(actor);
}

export async function testRoute(actor: Actor, modelId: string, routeId: string): Promise<ModelTestResult> {
  requireAdmin(actor);
  const loaded = await loadRoute(routeId);
  if (!loaded || loaded.route.modelId !== modelId) throw notFound("Route not found", "ROUTE_NOT_FOUND");
  const result = await runTest(loaded.route, loaded.kind);
  await db.insertInto("health_checks").values({ id: newId(), route_id: routeId, ok: result.ok, latency_ms: result.latencyMs, error: result.ok ? null : result.message.slice(0, 300) }).execute();
  return result;
}

// ─── Health ─────────────────────────────────────────────────────────────────

export async function health(actor: Actor): Promise<HealthRow[]> {
  requireAdmin(actor);
  const since = new Date(Date.now() - 86_400_000);
  const [routes, checks, traffic] = await Promise.all([
    db.selectFrom("model_routes").select(["id", "model_id", "provider_id", "upstream_model", "priority", "enabled"]).orderBy("model_id").orderBy("priority").execute(),
    db
      .selectFrom("health_checks")
      .select(["route_id", "ok", "latency_ms", "error", "checked_at", sql<number>`row_number() over (partition by route_id order by checked_at desc)`.as("rn")])
      .where("checked_at", ">=", since)
      .execute(),
    db
      .selectFrom("requests")
      .select([
        "route_id",
        sql<string>`count(*)`.as("n"),
        sql<string>`count(*) filter (where status_code < 400)`.as("ok"),
        sql<string | null>`percentile_cont(0.5) within group (order by latency_ms) filter (where status_code < 400)`.as("p50"),
      ])
      .where("created_at", ">=", since)
      .where("route_id", "is not", null)
      .groupBy("route_id")
      .execute(),
  ]);
  const byRoute = new Map(traffic.map((t) => [t.route_id!, t]));
  return Promise.all(
    routes.map(async (r) => {
      const t = byRoute.get(r.id);
      return {
        routeId: r.id,
        modelId: r.model_id,
        providerId: r.provider_id,
        upstreamModel: r.upstream_model,
        priority: r.priority,
        enabled: r.enabled,
        circuit: await circuitState(r.id),
        successRate24h: t && Number(t.n) ? Number(t.ok) / Number(t.n) : null,
        p50LatencyMs24h: t?.p50 === null || t?.p50 === undefined ? null : Math.round(Number(t.p50)),
        checks: checks
          .filter((c) => c.route_id === r.id && Number(c.rn) <= 12)
          .sort((a, b) => b.checked_at.getTime() - a.checked_at.getTime())
          .map((c) => ({ ok: c.ok, latencyMs: c.latency_ms, error: c.error, checkedAt: c.checked_at.toISOString() })),
      };
    }),
  );
}

export async function setCircuit(actor: Actor, routeId: string, state: "open" | "closed", meta: RequestMeta): Promise<void> {
  requireAdmin(actor);
  if (!(await db.selectFrom("model_routes").select("id").where("id", "=", routeId).executeTakeFirst())) throw notFound("Route not found", "ROUTE_NOT_FOUND");
  await forceCircuit(routeId, state);
  await audit({ actorId: actor.id, action: `route.circuit_${state}`, entityType: "route", entityId: routeId, ip: meta.ip });
}
