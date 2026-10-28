/**
 * Redis connections. BullMQ needs `maxRetriesPerRequest: null` on its connections; rate
 * limiting and the once-only mail claims share one general client.
 */
import { Redis, type RedisOptions } from "ioredis";
import { config } from "../core/config";

const base: RedisOptions = { lazyConnect: false, enableReadyCheck: true };

let shared: Redis | null = null;
const extra: Redis[] = [];

/** General-purpose client (rate limits, presence, caches). */
export function redis(): Redis {
  if (!shared) shared = new Redis(config.REDIS_URL, base);
  return shared;
}

/** A dedicated connection for BullMQ queues and workers. */
export function redisConnection(): Redis {
  const conn = new Redis(config.REDIS_URL, { ...base, maxRetriesPerRequest: null });
  extra.push(conn);
  return conn;
}

/** A fresh client owned by the caller (a BullMQ queue or worker). */
export function newRedisClient(): Redis {
  const conn = new Redis(config.REDIS_URL, base);
  extra.push(conn);
  return conn;
}

/**
 * A connection for pub/sub. A subscribed connection may only run (UN)SUBSCRIBE and PING,
 * so ioredis's ready check (an INFO) must be off; channels are re-subscribed after a reconnect.
 */
export function newSubscriberClient(): Redis {
  const conn = new Redis(config.REDIS_URL, { lazyConnect: false, enableReadyCheck: false, autoResubscribe: true });
  extra.push(conn);
  return conn;
}

export async function closeRedis(): Promise<void> {
  await Promise.all([shared, ...extra].filter(Boolean).map((c) => (c as Redis).quit().catch(() => undefined)));
  shared = null;
  extra.length = 0;
}
