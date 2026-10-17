#!/usr/bin/env bash
# One-liner installer for The Workstation (any container / VM / laptop with Node >= 20).
#   curl -fsSL https://raw.githubusercontent.com/OWNER/the-workstation/main/scripts/install.sh | bash
# Env: WORKSTATION_REPO (git url), WORKSTATION_REF (branch/tag, default main),
#      WORKSTATION_DIR (default ~/.local/share/workstation), WORKSTATION_BIN (default ~/.local/bin)
set -euo pipefail
REPO="${WORKSTATION_REPO:-https://github.com/OWNER/the-workstation.git}"
REF="${WORKSTATION_REF:-main}"
DIR="${WORKSTATION_DIR:-$HOME/.local/share/workstation}"
BIN="${WORKSTATION_BIN:-$HOME/.local/bin}"

fail() { echo "error: $*" >&2; exit 1; }
for c in git node npm; do command -v "$c" >/dev/null || fail "'$c' is required but not installed"; done
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || fail "Node >= 20 required (found $(node -v))"

if [ -d "$DIR/.git" ]; then
  echo "Updating $DIR"; git -C "$DIR" fetch --depth 1 origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD
else
  echo "Cloning $REPO ($REF) into $DIR"; mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
( cd "$DIR" && npm ci --no-audit --no-fund && npm run build )
[ -f "$DIR/packages/server/dist/cli.js" ] || fail "build failed: packages/server/dist/cli.js missing"

mkdir -p "$BIN"
cat > "$BIN/workstation" <<LAUNCH
#!/usr/bin/env bash
exec node "$DIR/packages/server/dist/cli.js" "\$@"
LAUNCH
chmod +x "$BIN/workstation"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: add $BIN to your PATH";; esac
echo "Installed. Run: workstation   (add --host 0.0.0.0 inside a container, --no-open on headless machines)"
