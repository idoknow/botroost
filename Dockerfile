# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.14-debian AS build
ENV CI=true
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json eslint.config.mjs vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN bun run build

FROM node:22.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --chown=node:node deploy/node-entrypoint.sh /usr/local/bin/botroost-entrypoint
RUN chmod 0555 /usr/local/bin/botroost-entrypoint
ENTRYPOINT ["botroost-entrypoint"]

FROM runtime AS api
ENV BOTROOST_PROCESS=api
FROM runtime AS migrate
ENV BOTROOST_PROCESS=migrate
FROM runtime AS worker
ENV BOTROOST_PROCESS=worker
FROM runtime AS agent
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io \
 && rm -rf /var/lib/apt/lists/*
ENV BOTROOST_PROCESS=agent
FROM runtime AS bootstrap
ENV BOTROOST_PROCESS=bootstrap

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER 101
