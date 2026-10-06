#!/usr/bin/env bash
# Make a port that listens on the GUEST's 127.0.0.1 reachable from the Mac's 127.0.0.1.
#   expose-port.sh GUEST_PORT [HOST_PORT] [--remove]      (HOST_PORT defaults to GUEST_PORT+10000)
# Three hops, all required (skip one and Mac curl returns 000):
#   guest: portproxy 0.0.0.0:HOST_PORT -> 127.0.0.1:GUEST_PORT (needs iphlpsvc) + inbound firewall rule
#   QEMU : hostfwd 127.0.0.1:HOST_PORT -> guest:HOST_PORT  (runtime only — re-run after every VM restart)
set -euo pipefail
source "$(dirname "$0")/vm_env.sh"
GP="${1:?usage: expose-port.sh GUEST_PORT [HOST_PORT] [--remove]}"; HP="$((GP + 10000))"; REMOVE=0
for a in "${@:2}"; do case $a in --remove) REMOVE=1;; *) HP=$a;; esac; done
VMRUN="$SKILL_SCRIPTS/vmrun.py"
if [ $REMOVE = 1 ]; then
  "$VMRUN" -a "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$HP; Remove-NetFirewallRule -DisplayName 'vm-expose $HP' -EA 0; 'removed'"
  hmp "hostfwd_remove tcp:127.0.0.1:$HP"
  exit 0
fi
"$VMRUN" -a "Set-Service iphlpsvc -StartupType Automatic; Start-Service iphlpsvc
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$HP 2>\$null | Out-Null
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$HP connectaddress=127.0.0.1 connectport=$GP
if (-not (Get-NetFirewallRule -DisplayName 'vm-expose $HP' -EA 0)) { New-NetFirewallRule -DisplayName 'vm-expose $HP' -Direction Inbound -Protocol TCP -LocalPort $HP -Action Allow | Out-Null }
'guest side ready'"
hmp "hostfwd_remove tcp:127.0.0.1:$HP" >/dev/null 2>&1 || true
hmp "hostfwd_add tcp:127.0.0.1:$HP-:$HP"
# An echoed hostfwd_add proves nothing; the usernet table does.
hmp "info usernet" | grep -qE "HOST_FORWARD.*127\.0\.0\.1 +$HP " && echo "exposed: Mac 127.0.0.1:$HP -> guest 127.0.0.1:$GP" || { echo "hostfwd not in 'info usernet'"; exit 1; }
