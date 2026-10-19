#!/usr/bin/env bash
# Pause / inspect a hub sandbox from the command line.
#
# The manual sandbox-sharing regression (sandbox_share_link.md) needs the box to
# be PAUSED before the recipient follows the shared link — that is the whole
# point of the `open-service` route, which resumes a paused machine and waits for
# its app before redirecting. Pausing through the UI is not available (and would
# be a different flow anyway), so this drives the hub's own `ops/<op>` action.
#
#   ui/tests/manual_regression/sandbox/pause_sandbox.sh --name share-regression
#   ui/tests/manual_regression/sandbox/pause_sandbox.sh --id <uuid> --status-only
#   ui/tests/manual_regression/sandbox/pause_sandbox.sh --name share-regression --shutdown
#
# Credentials and hub URL default to the repo's own `.env.local`
# (FLOWPAD_HUB_URL / FLOWPAD_CLOUD_USER_EMAIL / FLOWPAD_CLOUD_USER_PASSWORD) so
# this file hardcodes no environment. Override with --hub / --email / --password.
#
# The credential must hold ADMIN or better on the node: `ops` is refused for a
# reader with "no valid access for role ['reader']". That bites exactly once and
# is easy to misread as a broken script -- after a HAND-OVER the sender keeps
# only `reader`, so the default (alice) can no longer pause a box she gave away.
# Pass the new owner with --email/--password.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"

read_env() {  # read_env KEY — last uncommented assignment wins, like dotenv
  [ -f "$ENV_FILE" ] || return 0
  # `|| true`: a key that is absent or commented out is the normal case (the repo
  # ships FLOWPAD_HUB_URL commented), and under `set -e` a failing grep inside a
  # command substitution would kill the script before it could read its flags.
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"'' | tr -d '\r' || true
}

HUB="${FLOWPAD_HUB_URL:-$(read_env FLOWPAD_HUB_URL)}"
HUB="${HUB:-http://localhost:8093}"
EMAIL="${FLOWPAD_CLOUD_USER_EMAIL:-$(read_env FLOWPAD_CLOUD_USER_EMAIL)}"
PASSWORD="${FLOWPAD_CLOUD_USER_PASSWORD:-$(read_env FLOWPAD_CLOUD_USER_PASSWORD)}"
NAME="" ; NODE_ID="" ; OP="pause"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)        NAME="$2"; shift 2;;
    --id)          NODE_ID="$2"; shift 2;;
    --hub)         HUB="$2"; shift 2;;
    --email)       EMAIL="$2"; shift 2;;
    --password)    PASSWORD="$2"; shift 2;;
    --status-only) OP="status"; shift;;
    --resume)      OP="resume"; shift;;
    --shutdown)    OP="shutdown"; shift;;
    -h|--help)     sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

[ -n "$NAME$NODE_ID" ] || { echo "need --name <sandbox name> or --id <uuid>" >&2; exit 2; }
[ -n "$EMAIL" ] && [ -n "$PASSWORD" ] || { echo "no hub credentials (set --email/--password or FLOWPAD_CLOUD_USER_*)" >&2; exit 2; }

HUB="${HUB%/}"
JAR="$(mktemp -t sandbox-ops-jar)"
trap 'rm -f "$JAR"' EXIT

# ---- 1. hub session ---------------------------------------------------------
# /api/v1/login sets the token cookie AND returns it in the envelope; the cookie
# jar is what the graph routes read, so that is what we carry forward.
login="$(curl -s -m 15 -c "$JAR" -X POST "$HUB/api/v1/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" || true)"
# `|| true` above so a transport failure (hub not running) reports THIS line's
# sentence rather than aborting on curl's bare exit code with nothing printed.
echo "$login" | grep -q '"SUCCESS"' || {
  echo "hub login failed as $EMAIL at $HUB: ${login:-no response — is the hub running?}" >&2; exit 1; }
echo "signed in to $HUB as $EMAIL"

api() { curl -s -m 120 -b "$JAR" "$@"; }

# ---- 2. resolve the node ----------------------------------------------------
# By NAME, never by a derived id: the sandbox's id is a plain uuid4 minted at
# create time and nothing about it can be computed from the name.
if [ -z "$NODE_ID" ]; then
  nodes="$(api "$HUB/api/v1/graph/compute_node")"
  NODE_ID="$(printf '%s' "$nodes" | python3 -c '
import json,sys
name = sys.argv[1]
payload = json.load(sys.stdin).get("data") or []
rows = payload if isinstance(payload, list) else [payload]
hits = [r for r in rows if (r or {}).get("name") == name]
if not hits:
    sys.stderr.write("no compute_node named %r (have: %s)\n"
                     % (name, ", ".join(sorted(str((r or {}).get("name")) for r in rows)) or "none"))
    sys.exit(1)
if len(hits) > 1:
    sys.stderr.write("%d nodes named %r — pass --id to disambiguate\n" % (len(hits), name))
    sys.exit(1)
print(hits[0]["id"])
' "$NAME")"
fi
echo "node: $NODE_ID"

# ---- 3. the op --------------------------------------------------------------
# POST /api/v1/graph/compute_node/<id>/ops/<op>. `pause` here is the immediate,
# user-initiated pause — not E2B's delayed auto-pause.
report_status() {
  api -X POST "$HUB/api/v1/graph/compute_node/$NODE_ID/ops/status" | python3 -c '
import json,sys
body = json.load(sys.stdin)
data = body.get("data") or {}
print("status: %s" % (data.get("status") or body.get("message") or "unknown"))
'
}

if [ "$OP" = "status" ]; then
  report_status
  exit 0
fi

res="$(api -X POST "$HUB/api/v1/graph/compute_node/$NODE_ID/ops/$OP")"
if ! echo "$res" | grep -q '"SUCCESS"'; then
  echo "$OP failed: ${res:0:300}" >&2
  # The one failure worth naming, because the message reads like a bug in this
  # script rather than the authorization decision it is.
  case "$res" in
    *"role \['reader'\]"*|*"no valid access for role"*)
      echo "hint: $EMAIL is not an admin on this node. After a hand-over the sender keeps only" >&2
      echo "      'reader' — pass the new owner with --email/--password." >&2;;
  esac
  exit 1
fi
echo "$OP ok"
report_status
