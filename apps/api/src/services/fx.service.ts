/**
 * The INR per USD rate. INR top-ups are converted into the one USD ledger at the rate in
 * force when the order is created, and that rate is stored on the top-up row, so a
 * payment that lands an hour later credits exactly what the buyer was shown (ADR 0004).
 *
 * The rate comes from the newest fx_rates row (written by the fx.sync job) when it is
 * less than two days old, else FX_FIXED_INR_PER_USD. A fetch failure never blocks a
 * top-up: the last good rate, or the fixed one, is used.
 */
import { config, isRealKey } from "../core/config";
import { newId } from "../core/ids";
import { captureError } from "../core/logger";
import { db } from "../db/kysely";

const MAX_AGE_MS = 48 * 3600_000;
const TTL_MS = 60_000;
let cache: { at: number; rate: number } | null = null;

export async function inrPerUsd(): Promise<number> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rate;
  let rate = config.FX_FIXED_INR_PER_USD;
  if (config.FX_PROVIDER !== "fixed") {
    const row = await db.selectFrom("fx_rates").select(["inr_per_usd", "fetched_at"]).orderBy("fetched_at", "desc").limit(1).executeTakeFirst();
    if (row && Date.now() - new Date(row.fetched_at).getTime() < MAX_AGE_MS) rate = Number(row.inr_per_usd);
  }
  cache = { at: Date.now(), rate };
  return rate;
}

export function clearFxCache(): void {
  cache = null;
}

/** Fetch today's rate from the configured provider and store it. Returns the rate, or null when nothing was fetched. */
export async function syncFx(): Promise<number | null> {
  if (config.FX_PROVIDER === "fixed") return null;
  let url: string;
  if (config.FX_PROVIDER === "openexchangerates") {
    if (!isRealKey(config.FX_API_KEY)) return null;
    url = `${config.FX_API_BASE ?? "https://openexchangerates.org/api"}/latest.json?app_id=${encodeURIComponent(config.FX_API_KEY)}&symbols=INR`;
  } else {
    url = `${config.FX_API_BASE ?? "https://open.er-api.com/v6"}/latest/USD`;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`FX provider answered ${res.status}`);
    const body = (await res.json()) as { rates?: { INR?: number } };
    const rate = Number(body.rates?.INR);
    // A sanity band: a rate outside it is a provider fault, not a market move.
    if (!Number.isFinite(rate) || rate < 10 || rate > 1000) throw new Error("FX provider returned an implausible rate");
    await db.insertInto("fx_rates").values({ id: newId(), inr_per_usd: String(rate), source: config.FX_PROVIDER }).execute();
    clearFxCache();
    return rate;
  } catch (err) {
    captureError(err, { where: "fx.sync" });
    return null;
  }
}
