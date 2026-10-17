#!/bin/bash
# Run by `devcontainer features test`. Uses source=local with an empty mount so only the plumbing is checked.
set -e
# shellcheck source=/dev/null
source dev-container-features-test-lib
check "launcher exists" test -x /usr/local/bin/workstation
check "url helper exists" test -x /usr/local/bin/workstation-url
check "node >= 20" node -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)'
check "config dir" test -d /usr/local/share/workstation-config
check "default host is loopback" grep -qx 127.0.0.1 /usr/local/share/workstation/host
check "claude code CLI not installed by default" test ! -e /usr/local/lib/node_modules/@anthropic-ai/claude-code
reportResults
