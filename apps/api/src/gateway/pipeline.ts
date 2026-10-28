/**
 * The data plane's one path, shared by every endpoint (ADR 0003, ADR 0005, ADR 0007):
 *
 *   1. authenticate the key (auth.ts)
 *   2. resolve the model and check it suits the endpoint
 *   3. key controls: model allow-list, IP allow-list, monthly budget
 *   4. rate limits: RPM and TPM per key, concurrency per account (limits.ts)
 *   5. price: margin = key ?? account ?? model ?? default; list price = primary cost + margin
 *   6. reserve the worst-case price on the wallet, or 402
 *   7. try routes in priority order, skipping open circuits; fail over on retryable errors
 *      (before the first byte of a stream only)
 *   8. settle: charge the actual price, book the request row (and bodies if the key logs
 *      them), in one transaction
 *
 * An endpoint supplies the estimate for step 6 and an `execute` that calls one route and
 * writes the response. `execute` throws UpstreamError to fail over; once it has written
 * anything to the client it must return (with whatever usage it saw) instead of throwing.
 */
import type { Request, Response } from "express";
import type { ModelKind } from "@open-gateway/types";
import { newId } from "../core/ids";
import { captureError, logger } from "../core/logger";
import { db, type Executor } from "../db/kysely";
import { redis } from "../integrations/redis";
import { InsufficientBalanceError, release, reserve, settle } from "../billing/wallet";
import { getSettings } from "../services/settings.service";
import { authenticateKey, ipAllowed, type KeyContext } from "./auth";
import { allow, recordFailure, recordSuccess } from "./breaker";
import { resolveModel, type CatalogModel, type CatalogRoute } from "./catalog";
import { GatewayError, sendGatewayError } from "./errors";
import { acquireSlot, admit, correctTokens, RateLimitError } from "./limits";
import { effectiveMargin, priceList, tokenAmount, unitAmount } from "./pricing";
import { UpstreamError } from "./upstream";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Images, characters or minutes, for unit-priced kinds. */
  units: number;
  /** True when the provider reported nothing and the numbers are our estimate. */
  estimated: boolean;
}

export interface Outcome {
  usage: Usage;
  statusCode: number;
  /** For keys that log bodies: the response (or the assembled stream). */
  responseBody?: unknown;
  /** Set when a stream broke after the first byte: billed for what was delivered. */
  errorCode?: string;
  ttfbMs?: number;
}

export interface CallSpec {
  endpoint: string;
  format: "openai" | "anthropic";
  modelName: unknown;
  kinds: ModelKind[];
  stream: boolean;
  /** For reservations and TPM: estimated input tokens and the most output tokens the call may produce. */
  estimate: (model: CatalogModel) => { inputTokens: number; maxOutputTokens: number; units: number };
  /** For keys that log bodies. */
  requestBody: unknown;
  execute: (route: CatalogRoute, model: CatalogModel, ctx: { signal: AbortSignal; started: number }) => Promise<Outcome>;
}

const PER_MILLION_UNIT_KINDS: ModelKind[] = ["SPEECH"];

function monthKey(keyId: string, d = new Date()): string {
  return `gwspend:${keyId}:${d.toISOString().slice(0, 7)}`;
}

/** Spend with a key this month, in micro-USD: a Redis counter seeded from the requests table. */
export async function keySpendThisMonth(keyId: string): Promise<number> {
  const k = monthKey(keyId);
  const hit = await redis().get(k).catch(() => null);
  if (hit !== null) return Number(hit);
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const row = await db.selectFrom("requests").select((eb) => eb.fn.coalesce(eb.fn.sum<number>("price_micros"), eb.lit(0)).as("s")).where("api_key_id", "=", keyId).where("created_at", ">=", start).executeTakeFirst();
  const total = Number(row?.s ?? 0);
  await redis().set(k, String(total), "EX", 40 * 86400, "NX").catch(() => undefined);
  return Number((await redis().get(k).catch(() => null)) ?? total);
}

function chargeFor(model: CatalogModel, prices: { inputMicrosPerMtok: number; outputMicrosPerMtok: number; cachedMicrosPerMtok: number | null; unitMicros: number }, u: Usage): number {
  if (model.kind === "CHAT" || model.kind === "EMBEDDING") return tokenAmount(prices, u);
  return unitAmount(prices.unitMicros, u.units, PER_MILLION_UNIT_KINDS.includes(model.kind));
}

export async function runCall(req: Request, res: Response, spec: CallSpec): Promise<void> {
  const requestId = `req_${newId()}`;
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  let ctx: KeyContext | null = null;
  let reservationId: string | null = null;
  let releaseSlot: (() => Promise<void>) | null = null;
  const abort = new AbortController();
  // The response's close, not the request's: an IncomingMessage closes as soon as its
  // body has been read, which would abort every upstream call.
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    ctx = await authenticateKey(req);
    const name = typeof spec.modelName === "string" ? spec.modelName : "";
    if (!name) throw new GatewayError(400, "invalid_request_error", "model_required", "`model` is required.", "model");
    const model = await resolveModel(name);
    if (!model) throw new GatewayError(404, "not_found_error", "model_not_found", `The model '${name.slice(0, 120)}' does not exist or is not available.`, "model");
    if (!spec.kinds.includes(model.kind)) throw new GatewayError(400, "invalid_request_error", "model_not_supported", `The model '${model.id}' cannot be used with ${spec.endpoint}.`, "model");
    if (ctx.allowedModels.length && !ctx.allowedModels.includes(model.id)) throw new GatewayError(403, "permission_error", "model_not_allowed", `This API key may not use '${model.id}'.`, "model");
    if (!ipAllowed(req.ip, ctx.ipAllowlist)) throw new GatewayError(403, "permission_error", "ip_not_allowed", "This API key may not be used from this address.");

    const settings = await getSettings();
    const margin = effectiveMargin(ctx.keyMarginBps, ctx.userMarginBps, model.marginBps, settings.defaultMarginBps);
    const prices = priceList(model.listCost, margin);
    const est = spec.estimate(model);
    const worst = chargeFor(model, prices, { inputTokens: est.inputTokens, outputTokens: est.maxOutputTokens, cachedTokens: 0, units: est.units, estimated: true });

    if (ctx.monthlyBudgetMicros !== null) {
      const spent = await keySpendThisMonth(ctx.keyId);
      if (spent + worst > ctx.monthlyBudgetMicros) throw new GatewayError(402, "insufficient_balance", "budget_exceeded", "This API key has reached its monthly budget.");
    }
    try {
      await admit(ctx.keyId, ctx.limits, est.inputTokens + est.maxOutputTokens);
      releaseSlot = await acquireSlot(ctx.userId, ctx.limits.concurrency);
    } catch (err) {
      if (err instanceof RateLimitError) {
        const what = err.kind === "requests" ? "requests per minute" : err.kind === "tokens" ? "tokens per minute" : "requests in flight";
        const code = err.kind === "requests" ? "rate_limit_exceeded" : err.kind === "tokens" ? "tokens_rate_limit_exceeded" : "concurrency_limit_exceeded";
        throw new GatewayError(429, "rate_limit_error", code, `Rate limit reached: ${err.limit} ${what}. Retry after ${err.retryAfterSeconds} s.`, null, { "retry-after": String(err.retryAfterSeconds) });
      }
      throw err;
    }
    try {
      reservationId = await reserve(ctx.userId, worst);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) throw new GatewayError(402, "insufficient_balance", "insufficient_balance", "Your balance is too low for this request. Top up and try again.");
      throw err;
    }

    let attempts = 0;
    let outcome: Outcome | null = null;
    let served: CatalogRoute | null = null;
    let lastError: UpstreamError | null = null;
    for (const route of model.routes) {
      if (!(await allow(route.id))) continue;
      attempts++;
      try {
        outcome = await spec.execute(route, model, { signal: abort.signal, started });
        served = route;
        void recordSuccess(route.id);
        break;
      } catch (err) {
        if (abort.signal.aborted) throw new GatewayError(499, "api_error", "client_closed", "The client closed the connection.");
        if (!(err instanceof UpstreamError)) throw err;
        lastError = err;
        if (err.retryable || err.status === 401 || err.status === 403) void recordFailure(route.id);
        if (!err.retryable || res.headersSent) break;
      }
    }

    if (!outcome || !served) {
      await release(reservationId, ctx.userId);
      reservationId = null;
      await recordFailed(requestId, ctx, model, spec, started, attempts, lastError, req.ip);
      if (!attempts) throw new GatewayError(503, "overloaded_error", "no_route_available", "Every provider for this model is temporarily unavailable. Try again shortly.");
      if (lastError && !lastError.retryable) {
        throw lastError.status === 400 || lastError.status === 422 || lastError.status === 413
          ? new GatewayError(400, "invalid_request_error", "upstream_rejected", "The provider rejected the request. Check the parameters for this model.")
          : new GatewayError(502, "api_error", "upstream_error", "The provider could not serve this request.");
      }
      throw new GatewayError(502, "api_error", "upstream_unavailable", "The model's providers are failing right now. Try again shortly.");
    }

    const priceMicros = chargeFor(model, prices, outcome.usage);
    const costMicros = chargeFor(model, served.cost, outcome.usage);
    const keyId = ctx.keyId;
    const userId = ctx.userId;
    const logBodies = ctx.logBodies;
    const resId = reservationId;
    reservationId = null;
    await settle(resId, userId, priceMicros, { requestId, description: `${model.id} via ${spec.endpoint}` }, async (trx: Executor) => {
      await trx
        .insertInto("requests")
        .values({
          id: requestId,
          user_id: userId,
          api_key_id: keyId,
          model_id: model.id,
          route_id: served!.id,
          provider_id: served!.provider.id,
          endpoint: spec.endpoint,
          stream: spec.stream,
          status_code: outcome!.statusCode,
          error_code: outcome!.errorCode ?? null,
          attempts,
          input_tokens: outcome!.usage.inputTokens,
          output_tokens: outcome!.usage.outputTokens,
          cached_tokens: outcome!.usage.cachedTokens,
          units: outcome!.usage.units,
          estimated: outcome!.usage.estimated,
          latency_ms: Date.now() - started,
          ttfb_ms: outcome!.ttfbMs ?? null,
          cost_micros: costMicros,
          price_micros: priceMicros,
          margin_bps: margin,
          ip: req.ip ?? null,
        })
        .execute();
      if (logBodies) {
        await trx
          .insertInto("request_bodies")
          .values({ request_id: requestId, request: JSON.stringify(spec.requestBody ?? null), response: JSON.stringify(outcome!.responseBody ?? null), expires_at: new Date(Date.now() + settings.bodyRetentionDays * 86_400_000) })
          .execute();
      }
    });
    await redis()
      .multi()
      .incrby(monthKey(keyId), priceMicros)
      .expire(monthKey(keyId), 40 * 86400)
      .exec()
      .catch(() => undefined);
    void correctTokens(keyId, ctx.limits, est.inputTokens + est.maxOutputTokens, outcome.usage.inputTokens + outcome.usage.outputTokens);
  } catch (err) {
    if (reservationId && ctx) await release(reservationId, ctx.userId).catch((e) => captureError(e, { where: "pipeline.release" }));
    if (err instanceof GatewayError) {
      if (err.status === 499) return;
      sendGatewayError(res, err, spec.format);
      return;
    }
    captureError(err, { where: "pipeline", requestId });
    if (!res.headersSent) sendGatewayError(res, new GatewayError(500, "api_error", "internal_error", "Something went wrong. Try again."), spec.format);
    else res.end();
  } finally {
    if (releaseSlot) await releaseSlot();
  }
}

async function recordFailed(requestId: string, ctx: KeyContext, model: CatalogModel, spec: CallSpec, started: number, attempts: number, err: UpstreamError | null, ip: string | undefined): Promise<void> {
  try {
    await db
      .insertInto("requests")
      .values({
        id: requestId,
        user_id: ctx.userId,
        api_key_id: ctx.keyId,
        model_id: model.id,
        endpoint: spec.endpoint,
        stream: spec.stream,
        status_code: attempts ? 502 : 503,
        error_code: attempts ? (err?.kind === "http" ? `upstream_${err.status}` : `upstream_${err?.kind ?? "error"}`) : "no_route_available",
        attempts,
        latency_ms: Date.now() - started,
        provider_id: err?.providerId ?? null,
        ip: ip ?? null,
      })
      .execute();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "failed request not recorded");
  }
}
