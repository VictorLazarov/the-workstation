#!/usr/bin/env bash
# One-liner installer for The Workstation (any container / VM / laptop with Node >= 20).
#   REF=main        # or a release tag once one exists, or a full commit SHA (most reproducible)
#   curl -fsSLO https://raw.githubusercontent.com/VictorLazarov/the-workstation/$REF/scripts/install.sh
#   less install.sh && WORKSTATION_REF=$REF bash install.sh
# Env: WORKSTATION_REPO (git url), WORKSTATION_REF (branch, release tag or full commit SHA, default main; a branch floats),
#      WORKSTATION_DIR (default ~/.local/share/workstation), WORKSTATION_BIN (default ~/.local/bin)
set -euo pipefail
REPO="${WORKSTATION_REPO:-https://github.com/VictorLazarov/the-workstation.git}"
REF="${WORKSTATION_REF:-main}"
DIR="${WORKSTATION_DIR:-$HOME/.local/share/workstation}"
BIN="${WORKSTATION_BIN:-$HOME/.local/bin}"

fail() { echo "error: $*" >&2; exit 1; }
for c in git node npm; do command -v "$c" >/dev/null || fail "'$c' is required but not installed"; done
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || fail "Node >= 20 required (found $(node -v))"

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"
  if git -C "$DIR" fetch --depth 1 origin "$REF"; then git -C "$DIR" -c advice.detachedHead=false checkout -q FETCH_HEAD
  else fail "could not fetch '$REF'; that ref does not exist in $REPO (release tags are only created by the owner). Set WORKSTATION_REF to an existing branch, tag or full commit SHA, e.g. WORKSTATION_REF=\$(git rev-parse HEAD)"; fi
else
  echo "Cloning $REPO ($REF) into $DIR"; mkdir -p "$(dirname "$DIR")"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR" 2>/dev/null \
    || { rm -rf "$DIR"; git clone -q "$REPO" "$DIR" && git -C "$DIR" -c advice.detachedHead=false checkout -q "$REF"; } \
    || fail "could not check out '$REF'; that ref does not exist in $REPO (release tags are only created by the owner). Set WORKSTATION_REF to an existing branch, tag or full commit SHA, e.g. WORKSTATION_REF=\$(git rev-parse HEAD)"
fi
if printf '%s' "$REF" | grep -Eq '^[0-9a-f]{40}$'; then
  [ "$(git -C "$DIR" rev-parse HEAD)" = "$REF" ] || fail "checked-out commit does not match $REF"
fi
echo "Building commit $(git -C "$DIR" rev-parse HEAD)"
if ! ( cd "$DIR" && npm ci --no-audit --no-fund && npm run build ); then
  if [ "$(uname -s)" = Linux ]; then
    # node-pty has no Linux prebuilds, so npm compiles it with node-gyp; without a toolchain the install is silently
    # skipped and the TypeScript build then fails on the missing module.
    echo "hint: on Linux the terminal module (node-pty) is compiled locally. Install python3, make and a C++ compiler, then re-run:" >&2
    echo "        Debian/Ubuntu: sudo apt-get install -y python3 make g++     Alpine: apk add python3 make g++ linux-headers" >&2
    echo "        Fedora/RHEL:   sudo dnf install -y python3 make gcc-c++" >&2
  fi
  fail "build failed"
fi
[ -f "$DIR/packages/server/dist/cli.js" ] || fail "build failed: packages/server/dist/cli.js missing"

mkdir -p "$BIN"
cat > "$BIN/workstation" <<LAUNCH
#!/usr/bin/env bash
exec node "$DIR/packages/server/dist/cli.js" "\$@"
LAUNCH
chmod +x "$BIN/workstation"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: add $BIN to your PATH";; esac
echo "Installed. Run: workstation   (add --host 0.0.0.0 inside a container, --no-open on headless machines)"
