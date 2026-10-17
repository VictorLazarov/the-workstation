# Standalone image:
#   docker build -t workstation . && docker run --rm -p 127.0.0.1:7777:7777 -v ws-config:/config -v "$PWD:/workspace" workstation
# The sign-in URL (with the token) is printed to the container log: `docker logs <container>`.
# Base image override (e.g. an internal mirror): --build-arg NODE_IMAGE=registry.example/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
# node-pty has no Linux prebuilds: node-gyp needs python3, make and a C++ compiler. (npm silently skips a failed
# optional dependency and the TypeScript build then fails on the missing module.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build \
    && (cd packages/server && node -e 'require("node-pty")') \
    && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
# ripgrep: used by Claude Code's search tools when the project is large; pass --build-arg EXTRA_APT= to omit it
ARG EXTRA_APT=ripgrep
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ${EXTRA_APT} \
    && rm -rf /var/lib/apt/lists/* \
    # the project is usually a bind mount owned by another uid: do not trip git's "dubious ownership" check
    && git config --system --add safe.directory '*'
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production WORKSTATION_HOME=/config
# /config is 1777 so that `--user <any uid>` (compose: WORKSTATION_UID/GID) can create its config in a fresh volume;
# the server tightens it to 0700 when the running user owns it.
RUN mkdir -p /config /workspace && chown -R node:node /config /workspace && chmod 1777 /config
USER node
WORKDIR /workspace
VOLUME ["/config"]
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7777/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 0.0.0.0 so the published port works; the token still gates everything. Publish on 127.0.0.1 only.
ENTRYPOINT ["node", "/app/packages/server/dist/cli.js", "--host", "0.0.0.0", "--port", "7777", "--no-open"]
