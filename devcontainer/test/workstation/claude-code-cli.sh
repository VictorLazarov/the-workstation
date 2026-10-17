#!/bin/bash
set -u
source dev-container-features-test-lib
check "claude CLI is on PATH at the pinned version" bash -c 'claude --version | grep -q "^2.1.302 "'
reportResults
