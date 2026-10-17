#!/bin/bash
set -u
source dev-container-features-test-lib
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"
source "$HERE/_common.sh"
common_checks 7791
check "server is bound to 0.0.0.0 (not loopback only)" bash -c 'ss -ltn | grep -q "0.0.0.0:7791"'
# Reached through the container's own non-loopback address: token still required.
check "non-loopback address: no token -> 401" bash -c 'ip=$(hostname -i | awk "{print \$1}"); [ "$(curl -s -o /dev/null -w "%{http_code}" http://$ip:7791/api/health)" = 401 ]'
check "non-loopback address: token -> 200" bash -c 'ip=$(hostname -i | awk "{print \$1}"); t=$(workstation-url | sed "s/.*token=//"); [ "$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $t" http://$ip:7791/api/health)" = 200 ]'
reportResults
