#!/usr/bin/env bash
# Start the job queue (if needed) and the VM, then wait until the guest agent checks in.
#   VM_DIR=~/VMs/windows-11-arm start.sh [--no-wait]
set -euo pipefail
source "$(dirname "$0")/vm_env.sh"
if ! vmq_up; then
  nohup python3 "$SKILL_SCRIPTS/vmq_server.py" >"$VM_DIR/vmq_server.log" 2>&1 &
  sleep 1; vmq_up && echo "vmq server up on :$VMQ_PORT" || { echo "vmq server failed, see $VM_DIR/vmq_server.log"; exit 1; }
fi
if vm_running; then echo "VM already running"; else
  (cd "$VM_PARENT" && nohup "$QUICKEMU" --vm "$VM_NAME.conf" >"$VM_DIR/launch.out" 2>&1 &)
  echo "VM launching ($VM_CONF)"
fi
[ "${1:-}" = "--no-wait" ] && exit 0
wait_agents 300 && echo "guest ready: $("$SKILL_SCRIPTS/vmrun.py" -t 30 '$env:COMPUTERNAME')"
