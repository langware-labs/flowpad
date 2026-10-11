#!/usr/bin/env bash
# Roll the VM back to a snapshot (default clean-win11): disk + its UEFI vars copy.
#   reset.sh [SNAPSHOT] [--boot]        list snapshots: qemu-img snapshot -l -U "$VM_DIR/disk.qcow2"
# Whatever the guest did since that snapshot is discarded, so a running VM is stopped hard (quit).
# The VM may be in use by another session — check `vmrun.py --status` and ask before resetting.
set -euo pipefail
source "$(dirname "$0")/vm_env.sh"
SNAP=clean-win11; BOOT=0
for a in "$@"; do case $a in --boot) BOOT=1;; -h|--help) sed -n 2,5p "$0"; exit 0;; *) SNAP=$a;; esac; done
if vm_running; then
  hmp quit >/dev/null || true
  for _ in $(seq 1 20); do vm_running || break; sleep 1; done
fi
vm_running && { echo "VM still running; not touching the disk"; exit 1; }
cd "$VM_DIR"
qemu-img snapshot -a "$SNAP" disk.qcow2
if [ -f "OVMF_VARS.$SNAP.fd" ]; then cp "OVMF_VARS.$SNAP.fd" OVMF_VARS.fd; else echo "note: no OVMF_VARS.$SNAP.fd, keeping current UEFI vars"; fi
echo "reset to $SNAP"
[ $BOOT = 1 ] && exec "$SKILL_SCRIPTS/start.sh"
