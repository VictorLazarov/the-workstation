# shellcheck shell=bash
# Shared helpers for the scenario tests. Sourced by <scenario>.sh next to dev-container-features-test-lib.
# Runs inside the built container as the remote user.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/probe.mjs"
# shellcheck disable=SC2034 # used by the scenario scripts that source this file
CFG=/usr/local/share/workstation-config

# Wait for the autostarted server (postStartCommand) and echo its token.
wait_port() { # port [seconds]
  local p="$1" t="${2:-180}" i
  for ((i = 0; i < t * 2; i++)); do (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0; sleep 0.5; done
  return 1
}
token() { workstation-url | sed 's/.*token=//'; }

# A throw-away git repo for the worktree test.
make_repo() {
  rm -rf /tmp/probe-repo && git init -q -b main /tmp/probe-repo \
    && git -C /tmp/probe-repo -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
}

# Mock-mode server on a second port + full probe against it (sessions, worktree, terminal, auth).
probe_mock() {
  make_repo || return 1
  rm -rf /tmp/mock-home
  ( WORKSTATION_MOCK=1 WORKSTATION_HOME=/tmp/mock-home nohup workstation --port 7790 --no-open >/tmp/mock.log 2>&1 & echo $! >/tmp/mock.pid )
  wait_port 7790 60 || { cat /tmp/mock.log; return 1; }
  local t; t="$(sed -n 's/.*token=//p' /tmp/mock.log | head -1)"
  node "$PROBE" --base http://127.0.0.1:7790 --token "$t" --mock --local --cwd /tmp --repo /tmp/probe-repo
  local rc=$?
  kill "$(cat /tmp/mock.pid)" 2>/dev/null
  return $rc
}

# Real-SDK server (no credentials): auth, SPA, WS, terminal + the bundled claude binary launches.
probe_real() { # port
  node "$PROBE" --base "http://127.0.0.1:$1" --token "$(token)" --real-cli --local --cwd /tmp
}
