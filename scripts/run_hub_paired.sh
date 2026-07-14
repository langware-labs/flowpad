#!/usr/bin/env bash
# Run all two-process hub protocol pairs against caller-owned named instances.
# This runner never sources repo credentials, launches services, or guesses an
# identity. The generated env, launcher registry, canonical hub/credentials,
# and both launcher PIDs are validated synchronously before either half starts.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${FLOWPAD_HUB_URL:?FLOWPAD_HUB_URL must be set}"
: "${FLOW_INSTANCE:?FLOW_INSTANCE must select one share-pair member}"
: "${SHARE_INST_1:?SHARE_INST_1 must be set}"
: "${SHARE_INST_2:?SHARE_INST_2 must be set}"
: "${ALICE_EMAIL:?ALICE_EMAIL must be set}"
: "${ALICE_PW:?ALICE_PW must be set}"
: "${BOB_EMAIL:?BOB_EMAIL must be set}"
: "${BOB_PW:?BOB_PW must be set}"

[ "$SHARE_INST_1" != "$SHARE_INST_2" ] || {
  echo "[paired] SHARE_INST_1 and SHARE_INST_2 must be distinct" >&2
  exit 2
}
case "$FLOW_INSTANCE" in
  "$SHARE_INST_1"|"$SHARE_INST_2") ;;
  *)
    echo "[paired] FLOW_INSTANCE must equal SHARE_INST_1 or SHARE_INST_2" >&2
    exit 2
    ;;
esac

validate_instance() { # <name> <email> <password>
  local name="$1" email="$2" password="$3"
  HUB_PAIR_INSTANCE="$name" HUB_PAIR_EMAIL="$email" HUB_PAIR_PW="$password" node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const name = process.env.HUB_PAIR_INSTANCE;
const expectedEmail = process.env.HUB_PAIR_EMAIL;
const expectedPassword = process.env.HUB_PAIR_PW;
const expectedHub = (process.env.FLOWPAD_HUB_URL || '').replace(/\/$/, '');
const fail = (message) => {
  console.error(`[paired] ${name}: ${message}`);
  process.exit(2);
};
if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) fail('invalid instance name');

const parseEnv = (text) => {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

const envPath = path.join(root, `.env.${name}.local`);
let env;
let launcher;
try {
  env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  const flowHome = path.resolve(process.env.FLOW_HOME || path.join(os.homedir(), '.flow'));
  launcher = JSON.parse(fs.readFileSync(path.join(flowHome, 'instances', name, 'launcher.json'), 'utf8'));
} catch (error) {
  fail(`cannot read generated env/launcher registry: ${error.message}`);
}

const backendPort = env.LOCAL_SERVER_PORT;
const frontendPort = env.VITE_PORT;
const live = (value) => {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
if (
  env.FLOW_INSTANCE !== name ||
  !/^\d+$/.test(backendPort || '') ||
  !/^\d+$/.test(frontendPort || '') ||
  env.VITE_API_URL !== `http://localhost:${backendPort}` ||
  (env.FLOWPAD_HUB_URL || '').replace(/\/$/, '') !== expectedHub ||
  env.FLOWPAD_CLOUD_USER_EMAIL !== expectedEmail ||
  env.FLOWPAD_CLOUD_USER_PASSWORD !== expectedPassword ||
  launcher.name !== name ||
  Number(launcher.backend_port) !== Number(backendPort) ||
  Number(launcher.frontend_port) !== Number(frontendPort) ||
  (launcher.hub_url || '').replace(/\/$/, '') !== expectedHub ||
  launcher.email !== expectedEmail ||
  path.resolve(launcher.env_file || '') !== envPath ||
  !live(launcher.backend_pid) ||
  !live(launcher.frontend_pid)
) {
  fail('generated env, launcher identity/ports/hub/credentials, or live PIDs do not agree');
}
console.log(`[paired] validated ${name}: backend :${backendPort}, frontend :${frontendPort}, ${expectedEmail}`);
NODE
}

validate_instance "$SHARE_INST_1" "$ALICE_EMAIL" "$ALICE_PW"
validate_instance "$SHARE_INST_2" "$BOB_EMAIL" "$BOB_PW"

RENDEZVOUS_FILES=(
  /tmp/flowpad_matrix_conv.txt
  /tmp/flowpad_pingpong_conv.txt
  /tmp/flowpad_rename_joined.txt
  /tmp/flowpad_rename_http_done.txt
  /tmp/flowpad_rename_http_confirmed.txt
  /tmp/flowpad_rename_ws_done.txt
)
cleanup_rendezvous() { rm -f "${RENDEZVOUS_FILES[@]}"; }
trap cleanup_rendezvous EXIT
cleanup_rendezvous

run_pair() { # <alice-file> <bob-file>
  local alice="$1" bob="$2" arc brc
  echo "[paired] running $alice <-> $bob"
  (
    cd ui
    env FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" FLOW_INSTANCE="$SHARE_INST_2" \
      SHARE_INST_1="$SHARE_INST_1" SHARE_INST_2="$SHARE_INST_2" \
      ALICE_EMAIL="$ALICE_EMAIL" ALICE_PW="$ALICE_PW" \
      BOB_EMAIL="$BOB_EMAIL" BOB_PW="$BOB_PW" \
      npx vitest run --project hub-paired "$bob"
  ) &
  local bpid=$!
  sleep 8  # let bob pre-warm before alice's protocol window opens
  (
    cd ui
    env FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" FLOW_INSTANCE="$SHARE_INST_1" \
      SHARE_INST_1="$SHARE_INST_1" SHARE_INST_2="$SHARE_INST_2" \
      ALICE_EMAIL="$ALICE_EMAIL" ALICE_PW="$ALICE_PW" \
      BOB_EMAIL="$BOB_EMAIL" BOB_PW="$BOB_PW" \
      npx vitest run --project hub-paired "$alice"
  ) &
  local apid=$!
  if wait "$apid"; then arc=0; else arc=$?; fi
  if wait "$bpid"; then brc=0; else brc=$?; fi
  echo "[paired] $(basename "$alice") rc=$arc | $(basename "$bob") rc=$brc"
  return $(( arc || brc ))
}

rc=0
run_pair tests/hub/matrix.alice.test.ts tests/hub/matrix.bob.test.ts || rc=1
run_pair tests/hub/conversation_messages.test.ts tests/hub/conversation_messages.bob.test.ts || rc=1
run_pair tests/hub/rename.alice.test.ts tests/hub/rename.bob.test.ts || rc=1
exit "$rc"
