# Overtime, fully self-contained: the Worker + SQLite Durable Objects run in workerd (via
# `wrangler dev --local`) and persist to the /data volume. See docs/SELF_HOST.md.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV OVERTIME_DATA=/data PORT=8787 HOST=0.0.0.0 WRANGLER_SEND_METRICS=false NO_UPDATE_NOTIFIER=1 CI=1
WORKDIR /app
COPY --from=build /app/package.json /app/wrangler.toml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/worker ./worker
COPY --from=build /app/src ./src
COPY --from=build /app/scripts/selfhost.mjs ./scripts/selfhost.mjs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/selfhost.mjs"]
