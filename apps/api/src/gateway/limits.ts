/**
 * Rate limits for the data plane, in Redis so every API task shares one budget:
 *
 *   RPM          requests per minute, per key (sliding over two fixed windows)
 *   TPM          tokens per minute, per key: the input estimate is counted at admission
 *                and corrected with the actual input and output tokens at settlement
 *   concurrency  requests in flight, per account
 *
 * Each check-and-count is one Lua script, so parallel requests cannot all slip through.
 * The numbers come from the key (when set), else the account's tier, else the default
 * tier; null means unlimited. When Redis is unreachable the limits fail open (the wallet
 * reservation still bounds spend) and the failure is logged.
 */
import { captureError } from "../core/logger";
import { redis } from "../integrations/redis";

export interface Limits {
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
}

export class RateLimitError extends Error {
  constructor(
    readonly kind: "requests" | "tokens" | "concurrency",
    readonly limit: number,
    readonly retryAfterSeconds: number,
  ) {
    super(`rate limit: ${kind}`);
  }
}

// KEYS[1] current window, KEYS[2] previous window. ARGV: add, limit, window ms, now ms, ttl s.
// Weighted sliding window: prev x (1 - elapsed fraction) + current.
const WINDOW = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local add = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local frac = (tonumber(ARGV[4]) % tonumber(ARGV[3])) / tonumber(ARGV[3])
local used = prev * (1 - frac) + cur
if used + add > limit then return {0, math.floor(used)} end
local v = redis.call('INCRBY', KEYS[1], add)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return {1, v}`;

const MINUTE = 60_000;

function windowKeys(kind: string, id: string, now: number): [string, string] {
  const w = Math.floor(now / MINUTE);
  return [`rl:${kind}:${id}:${w}`, `rl:${kind}:${id}:${w - 1}`];
}

async function take(kind: "rpm" | "tpm", id: string, add: number, limit: number): Promise<void> {
  const now = Date.now();
  const [cur, prev] = windowKeys(kind, id, now);
  const [ok] = (await redis().eval(WINDOW, 2, cur, prev, add, limit, MINUTE, now, 130)) as [number, number];
  if (!ok) throw new RateLimitError(kind === "rpm" ? "requests" : "tokens", limit, Math.max(1, Math.ceil((MINUTE - (now % MINUTE)) / 1000)));
}

/** Count one request and its estimated tokens against the key, or throw RateLimitError. */
export async function admit(keyId: string, limits: Limits, estimatedTokens: number): Promise<void> {
  try {
    if (limits.rpm !== null) await take("rpm", keyId, 1, limits.rpm);
    if (limits.tpm !== null) await take("tpm", keyId, Math.max(1, estimatedTokens), limits.tpm);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    captureError(err, { where: "limits.admit" });
  }
}

/** After settlement: add what the estimate missed (output tokens, a larger input) to this minute's TPM. */
export async function correctTokens(keyId: string, limits: Limits, estimatedTokens: number, actualTokens: number): Promise<void> {
  if (limits.tpm === null) return;
  const delta = actualTokens - Math.max(1, estimatedTokens);
  if (delta <= 0) return;
  try {
    const [cur] = windowKeys("tpm", keyId, Date.now());
    await redis().multi().incrby(cur, delta).expire(cur, 130).exec();
  } catch (err) {
    captureError(err, { where: "limits.correct" });
  }
}

// KEYS[1] counter. ARGV: limit, ttl s. In-flight count with a safety expiry.
const ACQUIRE = `
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if v > tonumber(ARGV[1]) then redis.call('DECR', KEYS[1]) return 0 end
return 1`;

/** Take one in-flight slot for the account; the returned function gives it back (call it once). */
export async function acquireSlot(userId: string, limit: number | null): Promise<() => Promise<void>> {
  if (limit === null) return async () => undefined;
  const key = `rl:conc:${userId}`;
  try {
    const ok = Number(await redis().eval(ACQUIRE, 1, key, limit, 900));
    if (!ok) throw new RateLimitError("concurrency", limit, 1);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    captureError(err, { where: "limits.acquire" });
    return async () => undefined;
  }
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await redis()
      .eval(`if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end return 0`, 1, key)
      .catch((err) => captureError(err, { where: "limits.release" }));
  };
}
