/**
 * The console's usage views, all owner-scoped: a summary (totals, by day, by model, by
 * key) for a date range, the request log, and one request. Aggregation happens in SQL
 * on the requests table (requests_user_idx serves the range scan). Request bodies are
 * returned only to the account that made the request, only when its key logged them,
 * and only until they expire; admins never see them.
 */
import type { Page, RequestDetail, RequestRow, UsageQuery, UsageSummary } from "@open-gateway/types";
import { sql } from "kysely";
import { requireActor, type Actor } from "../core/context";
import { badRequest, notFound } from "../core/errors";
import { db } from "../db/kysely";
import { atKey, decodeTime, timePage } from "../repositories/keyset";

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;

/** [from, to) in UTC; defaults to the last 30 days including today. */
export function range(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const to = q.to ? new Date(new Date(q.to).getTime() + DAY) : new Date(today.getTime() + DAY);
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest("Invalid date range", "INVALID_RANGE");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY) throw badRequest(`Ranges can span at most ${MAX_RANGE_DAYS} days`, "INVALID_RANGE");
  return { from, to };
}

export async function summary(actor: Actor, q: UsageQuery): Promise<UsageSummary> {
  requireActor(actor);
  const { from, to } = range(q);
  const base = () => {
    let b = db.selectFrom("requests as r").where("r.user_id", "=", actor.id).where("r.created_at", ">=", from).where("r.created_at", "<", to);
    if (q.apiKeyId) b = b.where("r.api_key_id", "=", q.apiKeyId);
    if (q.modelId) b = b.where("r.model_id", "=", q.modelId);
    return b;
  };
  const isError = sql<number>`count(*) filter (where r.status_code >= 400)`;
  const [totals, daily, byModel, byKey] = await Promise.all([
    base()
      .select([
        (eb) => eb.fn.countAll<string>().as("requests"),
        isError.as("errors"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.input_tokens"), eb.lit(0)).as("input"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.output_tokens"), eb.lit(0)).as("output"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.price_micros"), eb.lit(0)).as("spend"),
        sql<string | null>`avg(r.latency_ms) filter (where r.status_code < 400)`.as("latency"),
      ])
      .executeTakeFirstOrThrow(),
    base()
      .select([sql<string>`to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as("date"), (eb) => eb.fn.countAll<string>().as("requests"), isError.as("errors"), (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.price_micros"), eb.lit(0)).as("spend")])
      .groupBy("date")
      .orderBy("date")
      .execute(),
    base()
      .select([
        "r.model_id",
        (eb) => eb.fn.countAll<string>().as("requests"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.input_tokens"), eb.lit(0)).as("input"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.output_tokens"), eb.lit(0)).as("output"),
        (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.price_micros"), eb.lit(0)).as("spend"),
      ])
      .groupBy("r.model_id")
      .orderBy("spend", "desc")
      .limit(50)
      .execute(),
    base()
      .leftJoin("api_keys as k", "k.id", "r.api_key_id")
      .select(["r.api_key_id", (eb) => eb.fn.max("k.name").as("name"), (eb) => eb.fn.countAll<string>().as("requests"), (eb) => eb.fn.coalesce(eb.fn.sum<string>("r.price_micros"), eb.lit(0)).as("spend")])
      .groupBy("r.api_key_id")
      .orderBy("spend", "desc")
      .limit(50)
      .execute(),
  ]);
  // Fill days without traffic so charts have a point for every day.
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const days: UsageSummary["daily"] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    const d = byDate.get(date);
    days.push({ date, requests: Number(d?.requests ?? 0), errors: Number(d?.errors ?? 0), spendMicros: Number(d?.spend ?? 0) });
  }
  return {
    from: from.toISOString().slice(0, 10),
    to: new Date(to.getTime() - DAY).toISOString().slice(0, 10),
    totals: {
      requests: Number(totals.requests),
      errors: Number(totals.errors),
      inputTokens: Number(totals.input),
      outputTokens: Number(totals.output),
      spendMicros: Number(totals.spend),
      avgLatencyMs: totals.latency === null ? null : Math.round(Number(totals.latency)),
    },
    daily: days,
    byModel: byModel.map((m) => ({ modelId: m.model_id, requests: Number(m.requests), inputTokens: Number(m.input), outputTokens: Number(m.output), spendMicros: Number(m.spend) })),
    byKey: byKey.map((k) => ({ apiKeyId: k.api_key_id, name: (k.name as string | null) ?? "Deleted key", requests: Number(k.requests), spendMicros: Number(k.spend) })),
  };
}

const ROW_COLUMNS = [
  "r.id",
  "r.api_key_id",
  "k.name as key_name",
  "r.model_id",
  "r.endpoint",
  "r.stream",
  "r.status_code",
  "r.error_code",
  "r.input_tokens",
  "r.output_tokens",
  "r.cached_tokens",
  "r.units",
  "r.estimated",
  "r.latency_ms",
  "r.ttfb_ms",
  "r.price_micros",
  "r.attempts",
  "r.created_at",
] as const;

type Row = {
  id: string;
  api_key_id: string | null;
  key_name: string | null;
  model_id: string;
  endpoint: string;
  stream: boolean;
  status_code: number;
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  units: string | number;
  estimated: boolean;
  latency_ms: number | null;
  ttfb_ms: number | null;
  price_micros: string | number;
  created_at: Date;
  has_bodies: boolean;
};

function toRow(r: Row): RequestRow {
  return {
    id: r.id,
    apiKeyId: r.api_key_id,
    apiKeyName: r.key_name,
    modelId: r.model_id,
    endpoint: r.endpoint,
    stream: r.stream,
    statusCode: r.status_code,
    errorCode: r.error_code,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    units: Number(r.units),
    estimated: r.estimated,
    latencyMs: r.latency_ms,
    ttfbMs: r.ttfb_ms,
    priceMicros: Number(r.price_micros),
    createdAt: r.created_at.toISOString(),
    hasBodies: r.has_bodies,
  };
}

const hasBodies = sql<boolean>`exists (select 1 from request_bodies b where b.request_id = r.id and b.expires_at > now())`.as("has_bodies");

export async function requests(actor: Actor, q: { cursor?: string; limit?: number; apiKeyId?: string; modelId?: string; status?: "ok" | "error" }): Promise<Page<RequestRow>> {
  requireActor(actor);
  const limit = q.limit ?? 25;
  // Request ids are "req_" + a ULID; the keyset cursor validates a bare ULID, so it pages on the ULID part.
  let query = db
    .selectFrom("requests as r")
    .leftJoin("api_keys as k", "k.id", "r.api_key_id")
    .select([...ROW_COLUMNS, hasBodies, atKey("r.created_at"), sql<string>`substr(r.id, 5)`.as("cursor_id")])
    .where("r.user_id", "=", actor.id);
  if (q.apiKeyId) query = query.where("r.api_key_id", "=", q.apiKeyId);
  if (q.modelId) query = query.where("r.model_id", "=", q.modelId);
  if (q.status === "ok") query = query.where("r.status_code", "<", 400);
  if (q.status === "error") query = query.where("r.status_code", ">=", 400);
  const key = decodeTime(q.cursor);
  const rows = await query
    .where(key ? sql<boolean>`(r.created_at, r.id) < (${key.at}::timestamptz, ${"req_" + key.id})` : sql<boolean>`true`)
    .orderBy("r.created_at", "desc")
    .orderBy("r.id", "desc")
    .limit(limit + 1)
    .execute();
  const page = timePage(rows.map((r) => ({ ...r, id: r.cursor_id, full: r.id })), limit);
  return { items: page.items.map((r) => toRow({ ...(r as unknown as Row), id: r.full })), nextCursor: page.nextCursor };
}

export async function request(actor: Actor, id: string): Promise<RequestDetail> {
  requireActor(actor);
  const r = await db.selectFrom("requests as r").leftJoin("api_keys as k", "k.id", "r.api_key_id").select([...ROW_COLUMNS, hasBodies]).where("r.id", "=", id).where("r.user_id", "=", actor.id).executeTakeFirst();
  if (!r) throw notFound("Request not found", "REQUEST_NOT_FOUND");
  const bodies = r.has_bodies ? await db.selectFrom("request_bodies").select(["request", "response"]).where("request_id", "=", id).where("expires_at", ">", new Date()).executeTakeFirst() : null;
  return { ...toRow(r as Row), attempts: r.attempts, bodies: bodies ? { request: bodies.request, response: bodies.response } : null };
}

