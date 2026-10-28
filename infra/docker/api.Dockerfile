# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# API image. One image, four commands:
#
#   node dist/index.js                         HTTP on PORT (default 5056): /api, /v1
#   node dist/worker.js                        BullMQ worker and scheduled jobs (no port)
#   node dist/migrate.js                       forward-only migrations (one-off task)
#   node dist/cli.js admin:create --email ...  bootstrap the first admin (one-off task)
#
#   docker build -f infra/docker/api.Dockerfile -t open-gateway-api .
#
# The four entry points are esbuild bundles (pnpm --filter @open-gateway/api build).
# Everything is bundled except the invoice PDF writer: pdfkit reads its fonts and colour
# profile from files next to its own code, so it stays external and the runtime stage
# installs exactly the locked version (pg-native is never installed: pg falls back to
# its JS client).
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Download every package in the lockfile first: this layer only changes with the lockfile.
# package.json too: it pins the pnpm version (packageManager) and carries the overrides
# the frozen lockfile is checked against.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @open-gateway/api...
RUN pnpm --filter @open-gateway/api build
# pdfkit and its dependencies only, at the version the lockfile resolved.
RUN mkdir /pdfkit && cd /pdfkit && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund "pdfkit@$(node -p "require('/repo/apps/api/node_modules/pdfkit/package.json').version")"

FROM ${NODE_IMAGE} AS runtime
# DATA_DIR only matters for MAIL_MODE=outbox. /tmp/data suits ECS (read-only root
# filesystem, writable /tmp); compose mounts a volume at /app/data instead.
ENV NODE_ENV=production TZ=UTC PORT=5056 \
    MIGRATIONS_DIR=/app/db/migrations DATA_DIR=/tmp/data
WORKDIR /app
# tini reaps zombies and forwards SIGTERM so the server drains and the worker stops cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /pdfkit/node_modules ./node_modules
# The bundled runner reads MIGRATIONS_DIR (db/migrate.ts), set above.
COPY --from=build --chown=node:node /repo/db/migrations ./db/migrations
USER node
EXPOSE 5056
# Liveness for the HTTP process. The worker has no port: compose and ECS override this.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5056)+'/up').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
