/**
 * Once per run: recreate and migrate the test database, empty the test Redis database,
 * and start the provider stubs
 * (apps/stubs) in-process on an ephemeral port so the suite is hermetic. Test files get
 * the stub URL through `inject("stubsUrl")` (env.ts puts it in STUBS_URL).
 */
import { Redis } from "ioredis";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { startStubs } from "../../../stubs/server.mjs";
import { testDatabaseUrl, testRedisUrl } from "./guard";

declare module "vitest" {
  export interface ProvidedContext {
    stubsUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = testDatabaseUrl();
  const target = new URL(url);
  const name = target.pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = url;
  const { migrate } = await import("../../../../db/migrate");
  await migrate({ log: () => undefined });

  // Rate-limit counters and queues from an earlier run must not leak into this one.
  // Only a numbered, non-zero Redis database is flushed (the suite's own, /1 by default).
  const redisUrl = new URL(testRedisUrl());
  if (/^\/[1-9]\d*$/.test(redisUrl.pathname)) {
    const r = new Redis(redisUrl.toString());
    await r.flushdb();
    await r.quit();
  }

  const stubs = await startStubs();
  project.provide("stubsUrl", stubs.url);
  return () => stubs.close();
}
