# Sourced by the qemu skill's shell scripts. One VM = one directory:
#   $VM_DIR/              disk.qcow2, OVMF_VARS*.fd, <name>-monitor.socket (HMP), qmp.socket (QMP)
#   $VM_DIR/../<name>.conf  the quickemu config (quickemu paths are relative to its parent dir)
VM_DIR="${VM_DIR:-$HOME/VMs/windows-11-arm}"
VM_DIR="${VM_DIR%/}"
VM_NAME="$(basename "$VM_DIR")"
VM_PARENT="$(dirname "$VM_DIR")"
VM_CONF="$VM_PARENT/$VM_NAME.conf"
VM_HMP="$VM_DIR/$VM_NAME-monitor.socket"
VM_QMP="$VM_DIR/qmp.socket"
VMQ_PORT="${VMQ_PORT:-8766}"
QUICKEMU="${QUICKEMU:-$HOME/.local/share/quickemu/quickemu}"
SKILL_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

vm_running() { pgrep -f "qemu-system.*$VM_NAME/disk.qcow2" >/dev/null; }
# HMP one-shot. `|| true`: grep -v exits 1 when the monitor prints nothing (most commands), which
# would abort callers running under set -e.
hmp() { printf '%s\n' "$*" | nc -U -w 3 "$VM_HMP" | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v -E '^\(qemu\)|^QEMU .* monitor' || true; }
vmq_up() { curl -s -m 2 "localhost:$VMQ_PORT/status" >/dev/null; }
# Wait until both agent lanes polled within the last few seconds (= the guest is logged in and ready).
wait_agents() {
  local secs="${1:-300}" s
  for _ in $(seq 1 $((secs / 5))); do
    s=$(curl -s -m 3 "localhost:$VMQ_PORT/status")
    python3 -c "import json,sys;d=json.loads(sys.argv[1] or '{}');sys.exit(0 if d.get('user',99)<6 and d.get('admin',99)<6 else 1)" "$s" 2>/dev/null && return 0
    sleep 5
  done
  echo "agents did not check in within ${secs}s (status: $s)" >&2; return 1
}
# Graceful power-off through the admin lane; falls back to nothing (callers decide on `quit`).
vm_shutdown() {
  vm_running || return 0
  curl -s -m 3 -X POST --data 'Stop-Computer -Force' "localhost:$VMQ_PORT/submit?lane=admin&timeout=60" >/dev/null || true
  for _ in $(seq 1 60); do vm_running || return 0; sleep 3; done
  return 1
}
