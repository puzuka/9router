# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine

# Registry/mirrors — defaults are the official sources (global CDN, fast for
# most regions incl. SEA). CN networks can build with:
#   --build-arg APK_MIRROR=mirrors.aliyun.com \
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG APK_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM ${NODE_IMAGE} AS base
ARG APK_MIRROR
WORKDIR /app
RUN sed -i "s|dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories

FROM base AS builder
# No `apk upgrade`: it re-downloads the whole userland (~6 min) on every
# build. Base-image updates come via `docker build --pull` / NODE_IMAGE bump.
RUN apk --no-cache add python3 make g++ linux-headers

# Install dependencies before copying sources so a source-only change hits
# the node_modules layer cache. /root/.npm is a persistent BuildKit cache:
# after a dependency bump, tarballs come from cache instead of the network.
COPY package.json package-lock.json ./
ARG NPM_REGISTRY
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --registry=$NPM_REGISTRY

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
ARG APK_MIRROR
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
