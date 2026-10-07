#!/usr/bin/env bash
# Build $VM_DIR/unattend.iso: the answer file + first-logon scripts + ARM64 virtio drivers.
#   WIN_TZ="Israel Standard Time" build-unattend.sh [path/to/virtio-win.iso]
# WIN_TZ is a Windows time-zone id (`tzutil /l`); QEMU feeds the guest the Mac's LOCAL time
# (rtc base=localtime), so set it to the Mac's zone or the guest clock is off by the difference.
# The ISO is attached as a USB CD (see windows-11-arm.conf.example): WinPE reads USB natively.
set -euo pipefail
source "$(dirname "$0")/vm_env.sh"
VIRTIO_ISO="${1:-$VM_DIR/virtio-win.iso}"
WIN_TZ="${WIN_TZ:-UTC}"
[ -f "$VIRTIO_ISO" ] || { echo "need virtio-win.iso: curl -L -o $VM_DIR/virtio-win.iso https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso"; exit 1; }
BUILD="$VM_DIR/unattend-build"; MNT="$(mktemp -d)"
rm -rf "$BUILD"; mkdir -p "$BUILD/drivers"
# Mount with hdiutil: bsdtar extraction of this ISO produced bad files.
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$VIRTIO_ISO" >/dev/null
trap 'hdiutil detach "$MNT" >/dev/null 2>&1 || true' EXIT
for d in viostor vioscsi NetKVM viogpudo vioserial Balloon; do
  cp -R "$MNT/$d/w11/ARM64" "$BUILD/drivers/$d"
done
chmod -R u+w "$BUILD/drivers"
cp "$SKILL_SCRIPTS/guest/setup-vm.ps1" "$SKILL_SCRIPTS/guest/agent.ps1" "$BUILD/"
sed "s|__WIN_TZ__|$WIN_TZ|" "$SKILL_SCRIPTS/guest/autounattend.xml" > "$BUILD/autounattend.xml"
rm -f "$VM_DIR/unattend.iso"
hdiutil makehybrid -quiet -o "$VM_DIR/unattend.iso" "$BUILD" -iso -joliet -default-volume-name UNATTEND
echo "built $VM_DIR/unattend.iso (TZ: $WIN_TZ)"; bsdtar -tf "$VM_DIR/unattend.iso" | grep -v '^drivers/.' 
