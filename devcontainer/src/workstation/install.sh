#!/usr/bin/env bash
# Dev Container Feature installer for The Workstation. Runs as root at image build time.
set -euo pipefail

SOURCE="${SOURCE:-git}"
VERSION="${VERSION:-v0.1.0}"
SOURCEURL="${SOURCEURL:-}"
LOCALPATH="${LOCALPATH:-/workspaces/the-workstation}"
PORT="${PORT:-7777}"
HOST="${HOST:-127.0.0.1}"
AUTOSTART="${AUTOSTART:-true}"
PRINTURL="${PRINTURL:-false}"
INSTALLCLAUDECODE="${INSTALLCLAUDECODE:-false}"
CLAUDECODEVERSION="${CLAUDECODEVERSION:-2.1.302}"
NODEVERSION="${NODEVERSION:-22}"
# PREFIX / ETC are overridable so the script can be tested in a scratch root.
PREFIX="${WORKSTATION_PREFIX:-/usr/local}"
INSTALL_DIR="${WORKSTATION_INSTALL_DIR:-$PREFIX/share/workstation}"
CONFIG_DIR="${WORKSTATION_CONFIG_DIR:-$PREFIX/share/workstation-config}"
DEFAULT_REPO="https://github.com/VictorLazarov/the-workstation.git"
USERNAME="${_REMOTE_USER:-root}"

log() { echo "[workstation-feature] $*"; }
die() { echo "[workstation-feature] ERROR: $*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ] && [ -z "${WORKSTATION_ALLOW_NONROOT:-}" ]; then
  die "must run as root (Dev Container Features install as root)"
fi

case "$SOURCE" in git|npm|tarball|local) ;; *) die "invalid source '$SOURCE' (git|npm|tarball|local)";; esac
case "$PORT" in ''|*[!0-9]*) die "port must be numeric";; esac
case "$HOST" in *[!A-Za-z0-9.:_-]*|'') die "invalid host '$HOST'";; esac
case "$CLAUDECODEVERSION" in ''|*[!0-9.]*) die "claudeCodeVersion must be an exact version like 2.1.302 (no ranges/tags)";; esac
case "$VERSION" in *[!A-Za-z0-9._/-]*|'') die "invalid version '$VERSION'";; esac

# ---- OS packages -------------------------------------------------------
pkg_install() {
  if command -v apt-get >/dev/null; then
    apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
  elif command -v apk >/dev/null; then apk add --no-cache "$@"
  elif command -v dnf >/dev/null; then dnf install -y "$@"
  elif command -v yum >/dev/null; then yum install -y "$@"
  else die "no supported package manager to install: $*"; fi
}
need=()
for c in curl git tar gzip; do command -v "$c" >/dev/null || need+=("$c"); done
command -v update-ca-certificates >/dev/null || need+=(ca-certificates)
if [ "${#need[@]}" -gt 0 ] && [ -z "${WORKSTATION_SKIP_PKGS:-}" ]; then pkg_install "${need[@]}"; fi

# ---- Node >= 20 --------------------------------------------------------
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
NODE_HINT='add "ghcr.io/devcontainers/features/node:1": { "version": "22" } before this feature (recommended), or use an image that ships Node >= 20'
# Official nodejs.org tarball, verified against the release's SHASUMS256.txt. No curl|bash, no third-party repos.
install_node_tarball() {
  local arch ver tmp file
  case "$NODEVERSION" in ''|*[!0-9]*) die "nodeVersion must be a major version number like 22";; esac
  arch="$(uname -m)"; case "$arch" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) die "unsupported arch $arch; $NODE_HINT";; esac
  command -v sha256sum >/dev/null || die "sha256sum is required to verify the Node download; $NODE_HINT"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/latest-v${NODEVERSION}.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    || die "could not download the Node $NODEVERSION checksums from nodejs.org; $NODE_HINT"
  file="$(grep -o "node-v${NODEVERSION}\.[0-9]*\.[0-9]*-linux-${arch}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "no Node $NODEVERSION linux-$arch tarball listed; $NODE_HINT"
  ver="${file#node-}"; ver="${ver%%-linux-*}"
  curl -fsSL "https://nodejs.org/dist/${ver}/${file}" -o "$tmp/$file" || die "Node download failed; $NODE_HINT"
  ( cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c - ) >/dev/null \
    || die "SHA256 mismatch for $file: refusing to install; $NODE_HINT"
  tar -xzf "$tmp/$file" -C "$PREFIX" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
  log "Installed Node $ver (sha256 verified)"
}
if ! node_ok; then
  log "Node >= 20 not found; installing Node $NODEVERSION"
  if command -v apk >/dev/null; then pkg_install nodejs npm # musl: distro package (signed by the package manager)
  else install_node_tarball
  fi
  node_ok || die "Node install failed; $NODE_HINT"
fi
log "Using node $(node -v), npm $(npm -v)"

# ---- Install The Workstation ------------------------------------------
mkdir -p "$PREFIX/bin" "$INSTALL_DIR"
build_checkout() { # $1 = dir containing the monorepo
  ( cd "$1" && npm ci --no-audit --no-fund && npm run build )
  [ -f "$1/packages/server/dist/cli.js" ] || die "build did not produce packages/server/dist/cli.js"
}
ENTRY=""
case "$SOURCE" in
  git)
    url="${SOURCEURL:-$DEFAULT_REPO}"
    log "Cloning $url @ $VERSION"
    rm -rf "$INSTALL_DIR/app"
    git clone --depth 1 --branch "$VERSION" "$url" "$INSTALL_DIR/app" 2>/dev/null \
      || { rm -rf "$INSTALL_DIR/app"; git clone -q "$url" "$INSTALL_DIR/app" && git -C "$INSTALL_DIR/app" -c advice.detachedHead=false checkout -q "$VERSION"; } \
      || die "could not check out '$VERSION' from $url. Set the feature option \"version\" to an existing release tag or full commit SHA (pinning a commit SHA is the most reproducible)."
    # a full commit SHA is verified, so the build is exactly that commit
    if printf '%s' "$VERSION" | grep -Eq '^[0-9a-f]{40}$'; then
      [ "$(git -C "$INSTALL_DIR/app" rev-parse HEAD)" = "$VERSION" ] || die "checked-out commit does not match $VERSION"
    fi
    log "Building commit $(git -C "$INSTALL_DIR/app" rev-parse HEAD)"
    build_checkout "$INSTALL_DIR/app"
    ENTRY="$INSTALL_DIR/app/packages/server/dist/cli.js" ;;
  tarball)
    [ -n "$SOURCEURL" ] || die "source=tarball requires sourceUrl"
    log "Downloading $SOURCEURL"
    rm -rf "$INSTALL_DIR/app"; mkdir -p "$INSTALL_DIR/app"
    curl -fsSL "$SOURCEURL" | tar -xz -C "$INSTALL_DIR/app" --strip-components=1
    build_checkout "$INSTALL_DIR/app"
    ENTRY="$INSTALL_DIR/app/packages/server/dist/cli.js" ;;
  npm)
    pkg="${SOURCEURL:-workstation}"; v="${VERSION#v}"; [ "$v" = main ] && v=latest
    log "npm install -g $pkg@$v"
    npm install -g --prefix "$INSTALL_DIR/npm" "$pkg@$v"
    for f in "$INSTALL_DIR"/npm/lib/node_modules/*/dist/cli.js "$INSTALL_DIR"/npm/lib/node_modules/*/packages/server/dist/cli.js; do
      [ -f "$f" ] && { ENTRY="$f"; break; }
    done
    [ -n "$ENTRY" ] || die "could not locate the CLI entry in the npm package" ;;
  local)
    log "source=local: will run the checkout at $LOCALPATH (built on first start if needed)"
    ENTRY="$LOCALPATH/packages/server/dist/cli.js" ;;
esac

# ---- Launcher ----------------------------------------------------------
cat > "$PREFIX/bin/workstation" <<LAUNCH
#!/usr/bin/env bash
# Launcher generated by the workstation Dev Container Feature.
export WORKSTATION_HOME="\${WORKSTATION_HOME:-$CONFIG_DIR}"
ENTRY="$ENTRY"
if [ "$SOURCE" = local ]; then
  ROOT="$LOCALPATH"
  if [ ! -f "\$ENTRY" ]; then
    echo "[workstation] building checkout at \$ROOT (first run)..." >&2
    (cd "\$ROOT" && npm ci --no-audit --no-fund && npm run build) >&2 || exit 1
  fi
fi
[ -f "\$ENTRY" ] || { echo "workstation: entry \$ENTRY not found" >&2; exit 1; }
exec node "\$ENTRY" "\$@"
LAUNCH
chmod 0755 "$PREFIX/bin/workstation"

# ---- Autostart + URL helper -------------------------------------------
cat > "$PREFIX/bin/workstation-autostart" <<AUTO
#!/usr/bin/env bash
# Runs as postStartCommand. Starts the server in the background. The tokenized URL is written to a 0600 file and NOT
# printed (postStart logs end up in shared bug reports); run 'workstation-url' to see it. Feature option printUrl=true
# (or WORKSTATION_PRINT_URL=1) prints it here instead.
umask 077
export WORKSTATION_HOME="\${WORKSTATION_HOME:-$CONFIG_DIR}"
[ -f "$INSTALL_DIR/autostart" ] || exit 0
PORT="\${WORKSTATION_PORT:-\$(cat "$INSTALL_DIR/port")}"
HOST="\${WORKSTATION_HOST:-\$(cat "$INSTALL_DIR/host")}"
LOG="\$WORKSTATION_HOME/server.log"
mkdir -p "\$WORKSTATION_HOME"
if ! (exec 3<>/dev/tcp/127.0.0.1/\$PORT) 2>/dev/null; then
  nohup "$PREFIX/bin/workstation" --host "\$HOST" --port "\$PORT" --no-open >"\$LOG" 2>&1 &
  echo \$! > "\$WORKSTATION_HOME/server.pid"
  disown 2>/dev/null || true
fi
for _ in \$(seq 1 120); do
  (exec 3<>/dev/tcp/127.0.0.1/\$PORT) 2>/dev/null && break
  sleep 0.5
done
if [ "\${WORKSTATION_PRINT_URL:-\$(cat "$INSTALL_DIR/printurl" 2>/dev/null || echo false)}" = true ] || [ "\${WORKSTATION_PRINT_URL:-}" = 1 ]; then
  exec "$PREFIX/bin/workstation-url"
fi
"$PREFIX/bin/workstation-url" >/dev/null 2>&1 || true # refreshes \$WORKSTATION_HOME/url (0600)
echo "The Workstation is running on port \$PORT. Run 'workstation-url' in a terminal to get the sign-in link."
AUTO
cat > "$PREFIX/bin/workstation-url" <<URL
#!/usr/bin/env bash
# Print the tokenized URL for the running Workstation (also kept in \$WORKSTATION_HOME/url, mode 0600).
umask 077
export WORKSTATION_HOME="\${WORKSTATION_HOME:-$CONFIG_DIR}"
PORT="\${WORKSTATION_PORT:-\$(cat "$INSTALL_DIR/port" 2>/dev/null || echo 7777)}"
u=\$(grep -ho 'https\\?://[^ ]*token=[^ ]*' "\$WORKSTATION_HOME/server.log" 2>/dev/null | tail -1)
if [ -z "\$u" ]; then
  t=\$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")}catch{}' "\$WORKSTATION_HOME/config.json")
  [ -n "\$t" ] && u="http://localhost:\$PORT/?token=\$t"
fi
if [ -n "\$u" ]; then
  printf '%s\n' "\$u" > "\$WORKSTATION_HOME/url" 2>/dev/null && chmod 600 "\$WORKSTATION_HOME/url" 2>/dev/null
  echo "The Workstation: \$u"
else echo "The Workstation: URL not available yet; see \$WORKSTATION_HOME/server.log" >&2; exit 1; fi
URL
chmod 0755 "$PREFIX/bin/workstation-autostart" "$PREFIX/bin/workstation-url"
echo "$PORT" > "$INSTALL_DIR/port"; echo "$HOST" > "$INSTALL_DIR/host"
if [ "$AUTOSTART" = true ]; then : > "$INSTALL_DIR/autostart"; else rm -f "$INSTALL_DIR/autostart"; fi
echo "$PRINTURL" > "$INSTALL_DIR/printurl"

# ---- Config dir (named volume mounts here; keep ownership for the user) --
mkdir -p "$CONFIG_DIR"
if id "$USERNAME" >/dev/null 2>&1; then chown -R "$USERNAME" "$CONFIG_DIR" 2>/dev/null || true; fi
chmod 700 "$CONFIG_DIR"
# Make the user's default location point at the same persisted dir.
if id "$USERNAME" >/dev/null 2>&1 && [ "$USERNAME" != root ] && [ -n "${_REMOTE_USER_HOME:-}" ]; then
  mkdir -p "$_REMOTE_USER_HOME/.config"
  [ -e "$_REMOTE_USER_HOME/.config/workstation" ] || ln -s "$CONFIG_DIR" "$_REMOTE_USER_HOME/.config/workstation"
  chown -h "$USERNAME" "$_REMOTE_USER_HOME/.config/workstation" "$_REMOTE_USER_HOME/.config" 2>/dev/null || true
fi

# ---- Claude Code CLI ---------------------------------------------------
# Off by default: the Agent SDK bundles its own Claude Code runtime. When enabled, an EXACT version is installed
# (default = the version bundled by the SDK this release uses), never a floating tag.
if [ "$INSTALLCLAUDECODE" = true ]; then
  log "Installing Claude Code CLI $CLAUDECODEVERSION"
  npm install -g --prefix "$PREFIX" "@anthropic-ai/claude-code@$CLAUDECODEVERSION" || log "WARNING: Claude Code CLI install failed (non-fatal; the Agent SDK bundles its own runtime)"
fi

log "Done. Run 'workstation' or 'workstation-url'."
