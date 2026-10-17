#!/usr/bin/env bash
# End-to-end test of the install paths against a REAL Docker daemon:
#   features  `devcontainer features test` over devcontainer/test/workstation/scenarios.json (the Dev Container Feature)
#   up        `devcontainer up` with a published port: loopback vs 0.0.0.0, token enforcement from the docker host,
#             config persistence across a container rebuild, clear error for an unknown version
#   image     the root Dockerfile and docker-compose.yml (non-root, published port, volume persistence, arbitrary uid)
#   installer scripts/install.sh run as a normal user in a clean container, then the installed `workstation` is probed
#
# Usage: scripts/test-devcontainer.sh [--stage features|up|image|installer|all] [scenario ...]
#        e.g. scripts/test-devcontainer.sh --stage features git-ubuntu tarball
#
# Needs: docker (+ buildx, compose plugin for the image stage), node >= 20 (npm), git, curl, tar.
#
# Environment (all optional):
#   DEVCONTAINER_CLI     path of an existing `devcontainer` binary (default: npm-installs @devcontainers/cli@$DEVCONTAINER_CLI_VERSION)
#   WS_TEST_WORKDIR      scratch directory (default: mktemp -d); removed on exit unless WS_TEST_KEEP=1
#   WS_TEST_HOST_ADDR    address under which containers reach this host (default: the docker bridge gateway)
#   WS_TEST_CA_BUNDLE    PEM file with extra CA certificates (TLS-intercepting proxy). Every base image is wrapped in a
#                        derived image that trusts it. Defaults to /root/.ccr/ca-bundle.crt when that file exists.
#   WS_TEST_PRUNE=1      prune the build cache / dangling images after every scenario (small disks, vfs storage driver)
#   WS_TEST_SKIP         space separated scenario names to skip (e.g. "git-alpine" where apk mirrors are unreachable)
#   WS_TEST_NODE_IMAGE   image stage: value of the Dockerfile's NODE_IMAGE build arg (default: the Dockerfile's own default)
#   WS_TEST_EXTRA_APT    image stage: value of the EXTRA_APT build arg (set to the empty string when the apt mirrors are unreachable)
#   WS_TEST_PORT         host port for the `up` stage's published port (default: a free port)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
DEVCONTAINER_CLI_VERSION="${DEVCONTAINER_CLI_VERSION:-0.89.0}"
STAGE=all
SCENARIOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    -h|--help) sed -n 2,25p "$0"; exit 0 ;;
    *) SCENARIOS+=("$1"); shift ;;
  esac
done
case "$STAGE" in features|up|image|installer|all) ;; *) echo "unknown stage $STAGE" >&2; exit 2 ;; esac
DEFAULT_SCENARIOS=(git-ubuntu git-node git-debian git-alpine tarball local-mount bind-all-interfaces autostart-off claude-code-cli)
[ "${#SCENARIOS[@]}" -gt 0 ] || SCENARIOS=("${DEFAULT_SCENARIOS[@]}")

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
FAILED=()
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; FAILED+=("$*"); }
die() { echo "ERROR: $*" >&2; exit 2; }

command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (DOCKER_HOST=${DOCKER_HOST:-unset})"
for c in node npm git curl tar; do command -v "$c" >/dev/null || die "$c not found"; done

W="${WS_TEST_WORKDIR:-$(mktemp -d)}"
mkdir -p "$W"
PIDS=()
LABELS=()
VOLUMES=()
cleanup() {
  local rc=$?
  set +e
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done        # by PID, never by pattern
  for l in "${LABELS[@]}"; do drop_labelled "$l"; done
  for v in "${VOLUMES[@]}"; do docker volume rm -f "$v" >/dev/null 2>&1; done
  docker ps -aq --filter "label=wstest=$$" | xargs -r docker rm -f >/dev/null 2>&1
  [ -n "${WS_TEST_KEEP:-}" ] || rm -rf "$W"
  exit $rc
}
# Remove the container(s) carrying label $1 and the workstation-config volume(s) they mounted (never other volumes).
drop_labelled() {
  local ids v
  ids="$(docker ps -aq --filter "label=$1")"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086
  v="$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' $ids 2>/dev/null)"
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null 2>&1
  # shellcheck disable=SC2086
  [ -z "$v" ] || docker volume rm -f $v >/dev/null 2>&1
}
trap cleanup EXIT

prune() { [ -z "${WS_TEST_PRUNE:-}" ] || { docker builder prune -af >/dev/null 2>&1; docker image prune -f >/dev/null 2>&1; } || true; }
free_port() { node -e 'const s=require("net").createServer().listen(0,"0.0.0.0",()=>{console.log(s.address().port);s.close()})'; }

# ---------------------------------------------------------------- tooling
if [ -n "${DEVCONTAINER_CLI:-}" ]; then DC="$DEVCONTAINER_CLI"
elif command -v devcontainer >/dev/null && [ "$(devcontainer --version)" = "$DEVCONTAINER_CLI_VERSION" ]; then DC="$(command -v devcontainer)"
else
  log "Installing @devcontainers/cli@$DEVCONTAINER_CLI_VERSION"
  mkdir -p "$W/cli" && (cd "$W/cli" && npm init -y >/dev/null && npm install --no-audit --no-fund "@devcontainers/cli@$DEVCONTAINER_CLI_VERSION" >/dev/null)
  DC="$W/cli/node_modules/.bin/devcontainer"
fi
echo "devcontainer CLI: $DC $("$DC" --version)"

# ---------------------------------------------------------------- repo snapshot served over git:// and http://
# The release does not exist yet: build a throw-away repository from the current working tree (committed or not), tag it
# with the feature's DEFAULT version, and let the containers clone it from a git daemon on this host.
FEATURE_VERSION_TAG="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).options.version.default' "$here/devcontainer/src/workstation/devcontainer-feature.json")"
SNAP="$W/served/snap"
rm -rf "$W/served" "$W/www" "$W/local-checkout" "$W/compose" "$W/up" "$W/up-bad" "$W/project"
mkdir -p "$SNAP"
( cd "$here" && git ls-files -co --exclude-standard -z | tar --ignore-failed-read --null -T - -cf - 2>/dev/null ) | tar -xf - -C "$SNAP"
( cd "$SNAP" && git init -q -b main . && git add -A && git -c user.name=ws-test -c user.email=ws-test@example.invalid -c commit.gpgsign=false commit -qm "snapshot for tests" \
  && git tag "$FEATURE_VERSION_TAG" )
GIT_SHA="$(git -C "$SNAP" rev-parse HEAD)"
HOST_ADDR="${WS_TEST_HOST_ADDR:-$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)}"
[ -n "$HOST_ADDR" ] || die "cannot determine the docker bridge gateway; set WS_TEST_HOST_ADDR"
GIT_PORT="$(free_port)"
git daemon --base-path="$W/served" --export-all --listen=0.0.0.0 --port="$GIT_PORT" --reuseaddr >"$W/gitd.log" 2>&1 &
PIDS+=($!)
GIT_URL="git://$HOST_ADDR:$GIT_PORT/snap"
for _ in $(seq 1 20); do git ls-remote "git://127.0.0.1:$GIT_PORT/snap" >/dev/null 2>&1 && break; sleep 0.25; done
git ls-remote "git://127.0.0.1:$GIT_PORT/snap" "refs/tags/$FEATURE_VERSION_TAG" | grep -q . || die "git daemon does not serve the snapshot (see $W/gitd.log)"
echo "snapshot $GIT_SHA tagged $FEATURE_VERSION_TAG, served at $GIT_URL"

# tarball (source=tarball) over http
mkdir -p "$W/www"
git -C "$SNAP" archive --format=tar.gz --prefix=the-workstation/ -o "$W/www/the-workstation.tar.gz" "$FEATURE_VERSION_TAG"
HTTP_PORT="$(free_port)"
node -e 'const h=require("http"),f=require("fs");h.createServer((q,r)=>{const p=process.argv[1]+"/"+q.url.split("?")[0].replace(/[^A-Za-z0-9._-]/g,"");f.readFile(p,(e,d)=>{if(e){r.writeHead(404);r.end();}else{r.writeHead(200);r.end(d);}})}).listen(+process.argv[2],"0.0.0.0")' "$W/www" "$HTTP_PORT" &
PIDS+=($!)
TARBALL_URL="http://$HOST_ADDR:$HTTP_PORT/the-workstation.tar.gz"

# source=local: a writable copy of the tree (the first start runs `npm ci` inside the bind mount, as the remote user)
LOCAL_CHECKOUT="$W/local-checkout"
mkdir -p "$LOCAL_CHECKOUT" && cp -a "$SNAP/." "$LOCAL_CHECKOUT/" && rm -rf "$LOCAL_CHECKOUT/.git" && chmod -R a+rwX "$LOCAL_CHECKOUT"

# ---------------------------------------------------------------- base images (optionally wrapped with a CA)
CA="${WS_TEST_CA_BUNDLE:-}"
[ -n "$CA" ] || { [ -f /root/.ccr/ca-bundle.crt ] && CA=/root/.ccr/ca-bundle.crt; } || true
declare -A IMGMAP=()
wrap_image() { # echoes the image to use for $1
  local base="$1" tag
  if [ -z "$CA" ]; then echo "$base"; return; fi
  tag="wstest-ca-$(printf '%s' "$base" | tr -c 'A-Za-z0-9\n' '-' | tr 'A-Z' 'a-z')"
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    mkdir -p "$W/ca" && cp "$CA" "$W/ca/ca.crt"
    cat > "$W/ca/Dockerfile" <<'DF'
ARG BASE
FROM ${BASE}
COPY ca.crt /usr/local/share/ca-certificates/extra-ca.crt
RUN if command -v update-ca-certificates >/dev/null; then update-ca-certificates; \
    else mkdir -p /etc/ssl/certs && cat /usr/local/share/ca-certificates/extra-ca.crt >> /etc/ssl/certs/ca-certificates.crt; fi
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
DF
    docker build -q --build-arg "BASE=$base" -t "$tag" "$W/ca" >/dev/null || die "could not build the CA image for $base"
  fi
  echo "$tag"
}
img() { [ -n "${IMGMAP[$1]:-}" ] || IMGMAP[$1]="$(wrap_image "$1")"; echo "${IMGMAP[$1]}"; }
UBUNTU="$(img mcr.microsoft.com/devcontainers/base:ubuntu)"


# ================================================================ stage: features
run_features() {
  log "devcontainer features test (scenarios: ${SCENARIOS[*]})"
  local proj="$W/project"
  rm -rf "$proj"; mkdir -p "$proj/src" "$proj/test"
  cp -a "$here/devcontainer/src/workstation" "$proj/src/workstation"
  cp -a "$here/devcontainer/test/workstation" "$proj/test/workstation"
  # render the scenario template
  local sedargs=(-e "s#@GIT_URL@#$GIT_URL#g" -e "s#@GIT_SHA@#$GIT_SHA#g" -e "s#@TARBALL_URL@#$TARBALL_URL#g" -e "s#@LOCAL_CHECKOUT@#$LOCAL_CHECKOUT#g")
  local m
  for m in $(grep -o '@IMG:[^@]*@' "$proj/test/workstation/scenarios.json" | sort -u); do
    local base="${m#@IMG:}"; base="${base%@}"
    sedargs+=(-e "s#$m#$(img "$base")#g")
  done
  sed "${sedargs[@]}" -i "$proj/test/workstation/scenarios.json"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$proj/test/workstation/scenarios.json" || die "rendered scenarios.json is invalid"
  local s
  for s in "${SCENARIOS[@]}"; do
    case " ${WS_TEST_SKIP:-} " in *" $s "*) echo "SKIP $s (WS_TEST_SKIP)"; continue ;; esac
    grep -q "^  \"$s\"" "$here/devcontainer/test/workstation/scenarios.json" || { fail "unknown scenario $s"; continue; }
    log "scenario $s"
    local before rc=0
    before="$(docker volume ls -q | sort)"
    "$DC" features test --project-folder "$proj" --features workstation --skip-autogenerated --filter "$s" >"$W/feature-$s.log" 2>&1 || rc=$?
    tail -n 30 "$W/feature-$s.log"
    if [ "$rc" = 0 ]; then pass "features/$s"; else fail "features/$s (exit $rc; log kept with WS_TEST_KEEP=1: $W/feature-$s.log)"; fi
    # config volumes created by the test containers (named workstation-config-<id>): remove only the new ones
    comm -13 <(printf '%s\n' "$before") <(docker volume ls -q | sort) | grep '^workstation-config-' | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    prune
  done
}

# ================================================================ stage: up (published port, persistence, errors)
write_up_workspace() { # dir host version
  local d="$1" host="$2" version="$3" port="$4"
  rm -rf "$d"; mkdir -p "$d/.devcontainer"
  cp -a "$here/devcontainer/src/workstation" "$d/.devcontainer/workstation"
  cat > "$d/.devcontainer/devcontainer.json" <<EOF
{
  "image": "$UBUNTU",
  "features": { "./workstation": { "source": "git", "sourceUrl": "$GIT_URL", "version": "$version", "host": "$host" } },
  "appPort": ["127.0.0.1:$port:7777"]
}
EOF
}
dcexec() { "$DC" exec --workspace-folder "$UPW" --id-label "$UPLABEL" "$@"; }

run_up() {
  log "devcontainer up: published ports"
  local port="${WS_TEST_PORT:-$(free_port)}"
  UPW="$W/up"; UPLABEL="wstest=$$-up"; LABELS+=("$UPLABEL")

  # 1) default host=127.0.0.1: the server only listens on the container's loopback, so `-p` cannot reach it
  write_up_workspace "$UPW" 127.0.0.1 "$FEATURE_VERSION_TAG" "$port"
  if "$DC" up --workspace-folder "$UPW" --id-label "$UPLABEL" >"$W/up1.log" 2>&1; then pass "up/loopback: container builds and starts"; else tail -30 "$W/up1.log"; fail "up/loopback: devcontainer up"; return; fi
  if [ "$(dcexec bash -c 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7777/api/health')" = 401 ]; then pass "up/loopback: reachable inside the container, token required (401)"; else fail "up/loopback: in-container health"; fi
  if curl -s -m 5 -o /dev/null "http://127.0.0.1:$port/api/health"; then fail "up/loopback: published port reachable although host=127.0.0.1 (docs claim it is not)"; else pass "up/loopback: published port NOT reachable with host=127.0.0.1 (as documented)"; fi
  drop_labelled "$UPLABEL"

  # 2) host=0.0.0.0 + published port
  write_up_workspace "$UPW" 0.0.0.0 "$GIT_SHA" "$port"
  if ! "$DC" up --workspace-folder "$UPW" --id-label "$UPLABEL" >"$W/up2.log" 2>&1; then tail -30 "$W/up2.log"; fail "up/0.0.0.0: devcontainer up"; return; fi
  pass "up/0.0.0.0: container builds and starts (commit-SHA pinned source)"
  local url token code
  url="$(dcexec workstation-url)"; token="${url##*token=}"
  [ -n "$token" ] || { fail "up/0.0.0.0: workstation-url printed no token"; return; }
  pass "up/0.0.0.0: workstation-url -> ${url%%token=*}token=<redacted>"
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health")"
  [ "$code" = 401 ] && pass "up/0.0.0.0: docker host, no token -> 401" || fail "up/0.0.0.0: no token returned $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" "http://127.0.0.1:$port/api/health")"
  [ "$code" = 200 ] && pass "up/0.0.0.0: docker host, token -> 200" || fail "up/0.0.0.0: token returned $code"
  if node "$here/devcontainer/test/workstation/probe.mjs" --base "http://127.0.0.1:$port" --token "$token" --real-cli --cwd /tmp >"$W/probe-host.log" 2>&1; then pass "up/0.0.0.0: full probe from the docker host (SPA, WS, terminal, real claude binary)"; else cat "$W/probe-host.log"; fail "up/0.0.0.0: probe from host"; fi
  # a wrong Host header (DNS rebinding) is refused even with the token
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' -H "authorization: Bearer $token" "http://127.0.0.1:$port/api/health")"
  [ "$code" = 403 ] && pass "up/0.0.0.0: forged Host header -> 403" || fail "up/0.0.0.0: forged Host returned $code"

  # 3) config persistence across a container rebuild
  dcexec bash -c 'echo kept > /usr/local/share/workstation-config/marker; echo gone > /tmp/not-persisted'
  "$DC" up --workspace-folder "$UPW" --id-label "$UPLABEL" --remove-existing-container >"$W/up3.log" 2>&1 || { tail -20 "$W/up3.log"; fail "up/rebuild: devcontainer up --remove-existing-container"; return; }
  local url2; url2="$(dcexec workstation-url)"
  [ "$url" = "$url2" ] && pass "up/rebuild: same token after the container was recreated (volume)" || fail "up/rebuild: token changed"
  [ "$(dcexec cat /usr/local/share/workstation-config/marker)" = kept ] && pass "up/rebuild: config volume content survives" || fail "up/rebuild: marker lost"
  dcexec test ! -e /tmp/not-persisted && pass "up/rebuild: container filesystem is fresh" || fail "up/rebuild: container was not recreated"
  [ "$(dcexec id -un)" != root ] && pass "up: remoteUser is not root ($(dcexec id -un))" || fail "up: remoteUser is root"

  # 4) clear failure for a version that does not exist
  write_up_workspace "$W/up-bad" 127.0.0.1 "v9.9.9-does-not-exist" "$port"
  local badlabel="wstest=$$-bad"; LABELS+=("$badlabel")
  if "$DC" up --workspace-folder "$W/up-bad" --id-label "$badlabel" >"$W/up-bad.log" 2>&1; then fail "up/bad-version: unexpectedly succeeded"
  elif grep -q "could not check out 'v9.9.9-does-not-exist'" "$W/up-bad.log"; then pass "up/bad-version: fails with the 'could not check out' hint"
  else tail -20 "$W/up-bad.log"; fail "up/bad-version: failed without the expected message"; fi
  drop_labelled "$UPLABEL"; drop_labelled "$badlabel"
  prune
}

# ================================================================ stage: image (Dockerfile + docker-compose.yml)
run_image() {
  log "Dockerfile"
  local iname="wstest-image-$$" port; port="$(free_port)"
  local bargs=() node_image="${WS_TEST_NODE_IMAGE:-}"
  [ -z "$node_image" ] && [ -n "$CA" ] && node_image="node:22-bookworm-slim"
  [ -z "$node_image" ] || bargs+=(--build-arg "NODE_IMAGE=$(img "$node_image")")
  [ -z "${WS_TEST_EXTRA_APT+x}" ] || bargs+=(--build-arg "EXTRA_APT=$WS_TEST_EXTRA_APT")
  if docker build "${bargs[@]}" -t "$iname" "$SNAP" >"$W/image-build.log" 2>&1; then pass "image: docker build"; else tail -30 "$W/image-build.log"; fail "image: docker build"; return; fi
  local c="wstest-img-$$" vol="wstest-cfg-$$" tok=""
  VOLUMES+=("$vol"); LABELS+=("wstest=$$")
  docker run -d --label "wstest=$$" --name "$c" -p "127.0.0.1:$port:7777" -v "$vol:/config" "$iname" >/dev/null
  for _ in $(seq 1 40); do tok="$(docker logs "$c" 2>&1 | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)"; [ -n "$tok" ] && curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.5; done
  [ -n "$tok" ] || { docker logs "$c" | tail; fail "image: server did not start"; return; }
  [ "$(docker exec "$c" id -un)" = node ] && pass "image: runs as non-root user 'node'" || fail "image: not running as node"
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health")" = 401 ] && pass "image: no token -> 401" || fail "image: no-token health"
  if node "$here/devcontainer/test/workstation/probe.mjs" --base "http://127.0.0.1:$port" --token "$tok" --real-cli --cwd /workspace >"$W/probe-image.log" 2>&1; then pass "image: full probe (SPA, WS, terminal, real claude binary)"; else cat "$W/probe-image.log"; fail "image: probe"; fi
  for _ in $(seq 1 30); do [ "$(docker inspect --format '{{.State.Health.Status}}' "$c")" = healthy ] && break; sleep 2; done
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$c")" = healthy ] && pass "image: HEALTHCHECK healthy" || fail "image: HEALTHCHECK not healthy"
  docker rm -f "$c" >/dev/null
  docker run -d --label "wstest=$$" --name "$c" -p "127.0.0.1:$port:7777" -v "$vol:/config" "$iname" >/dev/null
  sleep 3
  [ "$(docker logs "$c" 2>&1 | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)" = "$tok" ] && pass "image: token persists in the /config volume across containers" || fail "image: token changed across containers"
  docker rm -f "$c" >/dev/null

  log "docker-compose.yml (the real file, built from the snapshot)"
  if ! docker compose version >/dev/null 2>&1; then echo "SKIP compose (docker compose plugin missing)"; docker rmi -f "$iname" >/dev/null 2>&1; return; fi
  # Run as an arbitrary uid (not the image's 1000) to prove bind-mounted projects and the fresh /config volume work.
  local proj="wstest$$" uid cport; cport="$(free_port)"
  if [ "$(id -u)" = 0 ]; then uid=1234; else uid="$(id -u)"; fi
  local cd="$W/compose"; rm -rf "$cd"; mkdir -p "$cd"; cp -a "$SNAP/." "$cd/"; rm -rf "$cd/.git"
  [ "$(id -u)" != 0 ] || chown -R "$uid:$uid" "$cd"
  if [ "${#bargs[@]}" -gt 0 ]; then
    { echo "services:"; echo "  workstation:"; echo "    build:"; echo "      args:"
      local k=0; while [ "$k" -lt "${#bargs[@]}" ]; do [ "${bargs[$k]}" = --build-arg ] && { a="${bargs[$((k+1))]}"; echo "        ${a%%=*}: \"${a#*=}\""; }; k=$((k+1)); done
    } > "$cd/docker-compose.override.yml"
  fi
  local cenv=(env WORKSTATION_PORT="$cport" WORKSTATION_UID="$uid" WORKSTATION_GID="$uid")
  dc() { (cd "$cd" && "${cenv[@]}" docker compose -p "$proj" "$@"); }
  VOLUMES+=("${proj}_workstation-config")
  if dc up -d --build >"$W/compose-up.log" 2>&1; then pass "compose: up --build"; else tail -30 "$W/compose-up.log"; fail "compose: up --build"; dc down -v >/dev/null 2>&1; return; fi
  local ctok=""
  for _ in $(seq 1 40); do ctok="$(dc logs workstation 2>&1 | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' | head -1)"; [ -n "$ctok" ] && curl -s -o /dev/null "http://127.0.0.1:$cport/" && break; sleep 0.5; done
  [ -n "$ctok" ] || { dc logs workstation | tail; fail "compose: no token in the logs"; dc down -v >/dev/null 2>&1; return; }
  local cc; cc="$(dc ps -q workstation)"
  [ "$(docker exec "$cc" id -u)" = "$uid" ] && pass "compose: runs as uid $uid" || fail "compose: wrong uid"
  docker exec "$cc" bash -c 'cd /workspace && git init -q -b main . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git status --short >/dev/null && touch .ws-write-test && rm .ws-write-test' && pass "compose: bind-mounted ./ is readable, writable and trusted by git as uid $uid" || fail "compose: workspace access"
  if node "$here/devcontainer/test/workstation/probe.mjs" --base "http://127.0.0.1:$cport" --token "$ctok" --cwd /workspace >"$W/probe-compose.log" 2>&1; then pass "compose: probe through the published port"; else cat "$W/probe-compose.log"; fail "compose: probe"; fi
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$cport/api/health")" = 401 ] && pass "compose: no token -> 401" || fail "compose: no-token health"
  dc down >/dev/null 2>&1 && dc up -d >/dev/null 2>&1
  sleep 3
  [ "$(dc logs workstation 2>&1 | sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' | tail -1)" = "$ctok" ] && pass "compose: token persists across down/up (named volume)" || fail "compose: token changed after down/up"
  dc down -v >/dev/null 2>&1
  docker rmi -f "$iname" "${proj}-workstation" >/dev/null 2>&1 || true
  prune
}

run_installer() {
  log "scripts/install.sh in a clean container"
  local image; image="$(img mcr.microsoft.com/devcontainers/javascript-node:22)"
  local c="wstest-inst-$$"; LABELS+=("wstest=$$")
  if docker run --rm --label "wstest=$$" --name "$c" --user node \
      -v "$here/scripts/install.sh:/install.sh:ro" -v "$here/devcontainer/test/workstation/probe.mjs:/probe.mjs:ro" \
      -e "WORKSTATION_REPO=$GIT_URL" -e "WORKSTATION_REF=$FEATURE_VERSION_TAG" "$image" bash -c '
        set -e
        bash /install.sh
        export PATH="$HOME/.local/bin:$PATH"
        workstation --help | grep -q "Usage: workstation"
        export WORKSTATION_HOME=/tmp/ws-home
        (nohup workstation --port 7799 --no-open >/tmp/ws.log 2>&1 &)
        for _ in $(seq 1 60); do grep -q "token=" /tmp/ws.log 2>/dev/null && break; sleep 0.5; done
        t=$(sed -n "s/.*token=//p" /tmp/ws.log | head -1)
        node /probe.mjs --base http://127.0.0.1:7799 --token "$t" --real-cli --local --cwd /tmp
      ' >"$W/installer.log" 2>&1; then pass "installer: install.sh + server + probe (user node)"
  else tail -30 "$W/installer.log"; fail "installer: install.sh run"; fi
  if docker run --rm --label "wstest=$$" --user node -v "$here/scripts/install.sh:/install.sh:ro" \
      -e "WORKSTATION_REPO=$GIT_URL" -e "WORKSTATION_REF=v9.9.9-nope" "$image" bash /install.sh >"$W/installer-bad.log" 2>&1; then fail "installer: unknown ref unexpectedly succeeded"
  elif grep -q "could not check out 'v9.9.9-nope'" "$W/installer-bad.log"; then pass "installer: unknown ref fails with a clear message"
  else tail -10 "$W/installer-bad.log"; fail "installer: unknown ref failed without the expected message"; fi
  prune
}

case "$STAGE" in
  features) run_features ;;
  up) run_up ;;
  image) run_image ;;
  installer) run_installer ;;
  all) run_features; run_up; run_image; run_installer ;;
esac

echo
if [ "${#FAILED[@]}" -gt 0 ]; then printf 'FAILED (%d):\n' "${#FAILED[@]}"; printf '  - %s\n' "${FAILED[@]}"; exit 1; fi
echo "ALL DEVCONTAINER TESTS PASSED"
