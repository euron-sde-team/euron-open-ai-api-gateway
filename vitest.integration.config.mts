import { defineConfig } from "vitest/config";

/**
 * Integration tests: the real API (HTTP) in-process against a real Postgres
 * and Redis.
 *
 *   make test-integration
 *   TEST_DATABASE_URL=postgres://gw:gw@localhost:5522/gw_test \
 *   TEST_REDIS_URL=redis://localhost:6459/1 pnpm test:integration
 *
 * The global setup recreates and migrates the database once (refusing anything whose
 * name does not end in _test), empties the test Redis database, and starts the provider
 * stubs (apps/stubs) in-process on an ephemeral port. Files share that database, so they
 * run one at a time; every test creates its own users and chats, and a test that changes
 * shared state (settings, the default tier, the model catalogue) restores it.
 *
 * The same suite runs under every backend combination: see scripts/test-matrix.sh.
 */
export default defineConfig({
  test: {
    include: ["apps/api/test/integration/**/*.int.test.ts"],
    globalSetup: ["apps/api/test/integration/global-setup.ts"],
    setupFiles: ["apps/api/test/integration/env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
