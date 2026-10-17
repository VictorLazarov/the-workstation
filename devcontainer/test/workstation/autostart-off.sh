#!/bin/bash
set -u
source dev-container-features-test-lib
check "launcher installed" test -x /usr/local/bin/workstation
check "workstation --help works" bash -c 'workstation --help | grep -q "Usage: workstation"'
check "autostart marker absent" test ! -e /usr/local/share/workstation/autostart
check "nothing listens on 7777" bash -c '! (exec 3<>/dev/tcp/127.0.0.1/7777) 2>/dev/null'
check "workstation-autostart is a no-op" bash -c 'workstation-autostart; ! (exec 3<>/dev/tcp/127.0.0.1/7777) 2>/dev/null'
check "workstation-url reports no server" bash -c '! workstation-url 2>/dev/null'
reportResults
