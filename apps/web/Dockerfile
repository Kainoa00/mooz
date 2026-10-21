# Build from the repository root: docker build -f apps/web/Dockerfile .
# The base is pinned by digest (Node 22 slim), so a rebuild gets the same system underneath.
ARG NODE_IMAGE=node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @mooz/web
COPY apps/web apps/web
RUN pnpm -C apps/web build

FROM ${NODE_IMAGE}
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="mooz-web" \
      org.opencontainers.image.description="mooz: a meeting app where people bring their own AI agents" \
      org.opencontainers.image.source="https://github.com/Kainoa00/mooz" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# Standalone output leaves public/ out (it holds the connector agent's audio worklet).
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
# The slim image has no curl: ask Node. Ready means the database opens and the settings pass.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
