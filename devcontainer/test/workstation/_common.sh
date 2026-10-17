# shellcheck shell=bash
# Checks every autostarting scenario shares. Sourced after dev-container-features-test-lib and _lib.sh.
common_checks() { # port
  local port="${1:-7777}"
  check "workstation --help works" bash -c 'workstation --help | grep -q "Usage: workstation"'
  check "launcher, autostart and url helper installed" bash -c 'test -x /usr/local/bin/workstation && test -x /usr/local/bin/workstation-autostart && test -x /usr/local/bin/workstation-url'
  check "node >= 20" node -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)'
  check "autostarted server listens on $port" wait_port "$port" 180
  check "workstation-url prints a tokenized URL" bash -c 'workstation-url | grep -Eq "^The Workstation: http://[^ ]+/\?token=[A-Za-z0-9_-]{16,}$"'
  check "url file is 0600 and config dir is 0700" bash -c "[ \"\$(stat -c %a $CFG/url)\" = 600 ] && [ \"\$(stat -c %a $CFG)\" = 700 ]"
  check "config dir is writable by the remote user" bash -c "touch $CFG/.w && rm $CFG/.w"
  check "real-SDK server: auth, SPA, WS, terminal, bundled claude binary" probe_real "$port"
  check "mock server: sessions, git worktree, terminal, auth" probe_mock
}
