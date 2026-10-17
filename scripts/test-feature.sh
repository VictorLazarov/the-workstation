#!/usr/bin/env bash
# Offline smoke test of devcontainer/src/workstation/install.sh in a scratch prefix, using a stub
# monorepo as the git source. No root, network or Docker required. Usage: scripts/test-feature.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
stop_server() { # by PID (written by workstation-autostart), never by pattern
  local pf="$T/cfg/server.pid"
  if [ -f "$pf" ]; then kill "$(cat "$pf")" 2>/dev/null || true; rm -f "$pf"; fi
}
trap 'stop_server; rm -rf "$T"' EXIT
mkdir -p "$T/fake" "$T/prefix/bin"
cd "$T/fake"
echo '{"name":"fake","version":"1.0.0","scripts":{"build":"mkdir -p packages/server/dist && cp cli.src.js packages/server/dist/cli.js"}}' > package.json
echo '{"name":"fake","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fake","version":"1.0.0"}}}' > package-lock.json
cat > cli.src.js <<'JS'
const http=require("http"),fs=require("fs"),path=require("path");
const a=process.argv,port=+a[a.indexOf("--port")+1],host=a[a.indexOf("--host")+1];
const home=process.env.WORKSTATION_HOME;fs.mkdirSync(home,{recursive:true});
const cf=path.join(home,"config.json");let c;try{c=JSON.parse(fs.readFileSync(cf))}catch{c={token:"t"+Math.random().toString(36).slice(2)};fs.writeFileSync(cf,JSON.stringify(c),{mode:0o600})}
http.createServer((q,r)=>r.end("ok")).listen(port,host,()=>console.log(`http://localhost:${port}/?token=${c.token}`));
JS
git init -q -b main . && git add -A && git -c user.name=t -c user.email=t@t commit -qm init
cd "$here"
export WORKSTATION_ALLOW_NONROOT=1 WORKSTATION_SKIP_PKGS=1 WORKSTATION_PREFIX="$T/prefix" \
  SOURCE=git SOURCEURL="file://$T/fake" VERSION=main PORT=17799 INSTALLCLAUDECODE=false
bash devcontainer/src/workstation/install.sh >/dev/null
export PATH="$T/prefix/bin:$PATH" WORKSTATION_HOME="$T/cfg"
[ "$(cat "$T/prefix/share/workstation/host")" = 127.0.0.1 ] || { echo "FAIL: default host is not 127.0.0.1"; exit 1; }
out="$(workstation-autostart)"; echo "$out"
case "$out" in *token=*) echo "FAIL: autostart printed the tokenized URL by default"; exit 1;; esac
case "$out" in *workstation-url*) ;; *) echo "FAIL: autostart does not point to workstation-url"; exit 1;; esac
[ "$(curl -s localhost:17799)" = ok ] || { echo "FAIL: server not responding"; exit 1; }
[ "$(stat -c %a "$WORKSTATION_HOME/url")" = 600 ] || { echo "FAIL: url file is not 0600"; exit 1; }
url1="$(workstation-url)"; echo "$url1" | grep -q 'token=' || { echo "FAIL: workstation-url has no token"; exit 1; }
stop_server; sleep 1
url2="$(WORKSTATION_PRINT_URL=1 workstation-autostart)"
[ "$url1" = "$url2" ] || { echo "FAIL: token not persisted (or printUrl opt-in broken)"; exit 1; }
stop_server
echo "PASS"
