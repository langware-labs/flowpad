#!/usr/bin/env bash
# Take a disk snapshot (plus a copy of the UEFI vars) of the VM in its current state.
#   snapshot.sh NAME [--replace] [--boot]
# The VM is powered off gracefully first: a live snapshot is impossible (the raw efivars pflash
# blocks `savevm`), and qemu-img on a running image corrupts it. --replace overwrites an existing
# snapshot of that name (a name holds one state). --boot starts the VM again afterwards.
set -euo pipefail
source "$(dirname "$0")/vm_env.sh"
NAME="${1:?usage: snapshot.sh NAME [--replace] [--boot]}"; shift
REPLACE=0; BOOT=0
for a in "$@"; do case $a in --replace) REPLACE=1;; --boot) BOOT=1;; *) echo "unknown arg $a"; exit 2;; esac; done
if qemu-img snapshot -l -U "$VM_DIR/disk.qcow2" | awk '{print $2}' | grep -qx "$NAME"; then
  [ $REPLACE = 1 ] || { echo "snapshot '$NAME' exists; pass --replace to overwrite it"; exit 1; }
fi
if vm_running; then
  echo "shutting the guest down..."
  vm_shutdown || { echo "guest did not power off (agent down?). Stop it yourself, then rerun."; exit 1; }
fi
cd "$VM_DIR"
[ $REPLACE = 1 ] && qemu-img snapshot -d "$NAME" disk.qcow2 2>/dev/null || true
qemu-img snapshot -c "$NAME" disk.qcow2
cp OVMF_VARS.fd "OVMF_VARS.$NAME.fd"
qemu-img check disk.qcow2 | tail -1
qemu-img snapshot -l disk.qcow2
[ $BOOT = 1 ] && exec "$SKILL_SCRIPTS/start.sh"
