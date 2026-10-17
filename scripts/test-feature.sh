#!/usr/bin/env bash
# Offline smoke test of devcontainer/src/workstation/install.sh in a scratch prefix, using a stub
# monorepo as the git source. No root, network or Docker required. Usage: scripts/test-feature.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'pkill -f "$T/prefix/share/workstation/app" 2>/dev/null; rm -rf "$T"' EXIT
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
out="$(workstation-autostart)"; echo "$out"
[ "$(curl -s localhost:17799)" = ok ] || { echo "FAIL: server not responding"; exit 1; }
pkill -f "$T/prefix/share/workstation/app/packages/server/dist/cli.js"; sleep 1
out2="$(workstation-autostart)"
[ "$out" = "$out2" ] || { echo "FAIL: token not persisted"; exit 1; }
pkill -f "$T/prefix/share/workstation/app/packages/server/dist/cli.js" || true
echo "PASS"
