#!/bin/bash
# Full verification of an autostarted install (see _common.sh / probe.mjs).
set -u
source dev-container-features-test-lib
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"
source "$HERE/_common.sh"
common_checks 7777
reportResults
