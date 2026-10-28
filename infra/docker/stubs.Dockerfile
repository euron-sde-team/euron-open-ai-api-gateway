# syntax=docker/dockerfile:1.7
# Local stand-ins for the upstream providers (OpenAI-compatible, Anthropic) and the
# payment gateways (Stripe, Razorpay) (apps/stubs). One dependency-free script, port
# 5149. Development and CI only: production talks to the real services.
#   docker build -f infra/docker/stubs.Dockerfile -t open-gateway-stubs .
FROM node:22.23.4-alpine
ENV NODE_ENV=production PORT=5149
WORKDIR /app
COPY --chown=node:node apps/stubs/server.mjs apps/stubs/package.json ./
USER node
EXPOSE 5149
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5149)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
