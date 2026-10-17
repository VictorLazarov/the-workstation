# Standalone image: docker build -t workstation . && docker run -p 127.0.0.1:7777:7777 -v ws-config:/config workstation
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production WORKSTATION_HOME=/config
RUN mkdir -p /config /workspace && chown -R node:node /config /workspace
USER node
WORKDIR /workspace
VOLUME ["/config"]
EXPOSE 7777
# 0.0.0.0 so the published port works; the token still gates everything. Publish on 127.0.0.1 only.
ENTRYPOINT ["node", "/app/packages/server/dist/cli.js", "--host", "0.0.0.0", "--port", "7777", "--no-open"]
