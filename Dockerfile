# Project Alex — single container: API server + built web UI on one port.
# NODE_IMAGE can point at a mirror, e.g. public.ecr.aws/docker/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

# Manifests first for layer caching. The vendored Pi packages are workspaces,
# so their package.json files must be present for `npm ci`.
COPY package.json package-lock.json ./
COPY packages/alex-harness/package.json packages/alex-harness/
COPY vendor/pi-mono/packages/ai/package.json vendor/pi-mono/packages/ai/
COPY vendor/pi-mono/packages/agent/package.json vendor/pi-mono/packages/agent/
COPY vendor/pi-mono/packages/chord/package.json vendor/pi-mono/packages/chord/
COPY vendor/pi-mono/packages/telemetry/package.json vendor/pi-mono/packages/telemetry/
RUN npm ci --ignore-scripts

COPY . .
# Build the vendored Pi packages from source, then the web UI.
RUN npm run build:pi && npx vite build --config web/vite.config.ts \
 && npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=8787 ALEX_DATA_DIR=/data ALEX_VAULT_DIR=/app/data/vault

COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "server/src/index.ts"]
