#!/usr/bin/env bash
# local_patch.sh — local hot-patch for the uv-tool flowpad install.
#
# The LOCAL analog of the hub's cloud hot-patch (docs/cloud_patch.md). Same
# principles: capture tracked code at a commit with `git archive`, overlay it
# straight into the running deployment, restart the service — NO build, NO tests.
#
# Cloud:  git archive <SHA> | ssh | sudo tar -xf - -C /opt/flowpad_app/... && systemctl restart flowpad
# Local:  git archive <ref> |       tar -xf - -C <uv-tool site-packages>    && flow stop && flow start
#
# The uv-tool install (~/.local/share/uv/tools/flowpad/.../site-packages/flow_sdk)
# is a plain copy of the wheel — overwriting its .py files + restarting re-imports
# the patched code, exactly like the hub's source-tree systemd service.
#
# Usage:
#   scripts/local_patch.sh [<ref>] [options] [-- <path> ...]
#
#   <ref>            commit / tag / ref to capture (default: HEAD). Like cloud's <SHA>.
#   -- <path> ...    restrict the overlay to these repo paths (default: flow_sdk).
#                    e.g.  -- flow_sdk/server/app.py
#   --ui             also rebuild the UI (build_ui.py) and overlay the static bundle.
#   --no-restart     overlay only; don't stop/start the server.
#   --dry-run        list the files that WOULD be overlaid; change nothing.
#   -h, --help       this help.
#
# Examples:
#   scripts/local_patch.sh                              # overlay flow_sdk @ HEAD + restart
#   scripts/local_patch.sh abc1234                      # overlay flow_sdk @ abc1234 + restart
#   scripts/local_patch.sh -- flow_sdk/server/app.py    # single-file patch @ HEAD
#   scripts/local_patch.sh HEAD --ui                    # backend + rebuilt frontend
#
# NOTE (capture source): like cloud patch, this ships TRACKED files at a COMMIT.
# Uncommitted working-tree edits are NOT captured — commit them first (or `git
# stash create` and pass that sha as <ref>).
set -euo pipefail

# ---- target: the uv-tool flowpad install (the "local deployment") ----------
TOOL_DIR="${FLOW_TOOL_DIR:-$HOME/.local/share/uv/tools/flowpad}"
FLOW_BIN="$TOOL_DIR/bin/flow"
FLOW_PY="$TOOL_DIR/bin/python3"
PORT="${FLOWPAD_PROD_PORT:-9007}"          # prod port the uv-tool server binds
HEALTH="http://127.0.0.1:$PORT/api/v1/graph/bootstrap"

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_yel" "$c_off" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
health_check() { curl -fsS -m 3 "$HEALTH" >/dev/null 2>&1; }
# Run flow from $HOME, never the repo: run.py loads .env.local with override=True,
# so a repo-cwd 'flow' would hijack FLOW_INSTANCE=oss / port 9008 instead of prod.
flow_prod()    { ( cd "$HOME" && FLOWPAD_NO_BROWSER=1 "$FLOW_BIN" "$@" ); }
# Help is the header's Usage..NOTE block — marker-scraped so it can't drift out of
# sync with the source the way a fixed line range would.
usage() { sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

# ---- args ------------------------------------------------------------------
REF=""; DO_UI=0; DO_RESTART=1; DRY=0; PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ui)         DO_UI=1; shift;;
    --no-restart) DO_RESTART=0; shift;;
    --dry-run)    DRY=1; shift;;
    -h|--help)    usage; exit 0;;
    --)           shift; while [ $# -gt 0 ]; do PATHS+=("$1"); shift; done;;
    -*)           die "unknown option: $1";;
    *)            [ -z "$REF" ] && REF="$1" || PATHS+=("$1"); shift;;
  esac
done
REF="${REF:-HEAD}"
[ ${#PATHS[@]} -eq 0 ] && PATHS=("flow_sdk")   # wheel ships only flow_sdk

# ---- preflight -------------------------------------------------------------
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repo"
cd "$REPO_ROOT"
git rev-parse --verify --quiet "$REF^{commit}" >/dev/null || die "no such commit/ref: $REF"
[ -x "$FLOW_BIN" ] || die "uv-tool flow not found at $FLOW_BIN — run the local deployment first (uv tool install)"
# Resolve the install's site-packages cwd-independently (NOT by importing flow_sdk,
# which from the repo would resolve to the working tree, not the install).
SP="$("$FLOW_PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')" \
  || die "could not resolve site-packages for $FLOW_PY"
[ -d "$SP/flow_sdk" ] || die "flow_sdk not installed at $SP — run the local deployment first"

log "${c_dim}repo   : $REPO_ROOT${c_off}"
log "${c_dim}install: $SP${c_off}"
log "${c_dim}ref    : $REF   paths: ${PATHS[*]}${c_off}"

# ---- warn on paths the running server won't pick up / can't hot-patch ------
for p in "${PATHS[@]}"; do
  [[ "$p" == flow_sdk* ]] || warn "path '$p' is outside flow_sdk — not part of the installed package; the running server ignores it."
  if [[ "$p" == *pyproject.toml || "$p" == *uv.lock ]]; then
    warn "dependency manifest in patch set — an overlay does NOT install deps. Re-run the full local deployment (uv tool install) for dep changes."
  fi
done

# ---- 1. baseline (prove the change + enable rollback) ----------------------
log ""
log "── baseline ───────────────────────────────────────────────"
if cur_ver="$("$FLOW_BIN" 2>/dev/null)"; then log "  installed : $cur_ver"; fi
if health_check; then ok "server up on :$PORT"; else warn "server not currently answering on :$PORT"; fi

# ---- 2. capture @ ref  ->  tarball -----------------------------------------
TMP_TAR="$(mktemp -t flowpad_local_patch.XXXXXX.tar)"
trap 'rm -f "$TMP_TAR"' EXIT
git archive --format=tar -o "$TMP_TAR" "$REF" -- "${PATHS[@]}" \
  || die "git archive failed (do the paths exist at $REF?)"
# Read the tar index once; everything downstream works off this list.
FILES="$(tar -tf "$TMP_TAR" | grep -v '/$' || true)"
FILE_COUNT="$(printf '%s' "$FILES" | grep -c '' || true)"
[ -n "$FILES" ] || die "git archive produced 0 files for: ${PATHS[*]} @ $REF"

log ""
log "── capture @ $REF ($FILE_COUNT files) ─────────────────────"
printf '%s\n' "$FILES" | sed 's/^/  /' | head -40
[ "$FILE_COUNT" -gt 40 ] && log "  ${c_dim}… and $((FILE_COUNT - 40)) more${c_off}"

if [ "$DRY" = 1 ]; then log ""; warn "--dry-run: nothing applied."; exit 0; fi

# ---- 3. overlay into the install (the "tar -xf - -C <APP_DIR>") ------------
tar -xf "$TMP_TAR" -C "$SP"
ok "overlaid $FILE_COUNT file(s) into $SP"

# prove the overlay landed: first .py file's install copy must match the ref blob
FIRST_PY="$(printf '%s\n' "$FILES" | grep -m1 '\.py$' || true)"
if [ -n "$FIRST_PY" ]; then
  ref_sha="$(git show "$REF:$FIRST_PY" | shasum -a 256 | awk '{print $1}')"
  inst_sha="$(shasum -a 256 "$SP/$FIRST_PY" | awk '{print $1}')"
  if [ "$ref_sha" = "$inst_sha" ]; then ok "verified in place: $FIRST_PY"
  else die "overlay mismatch for $FIRST_PY (install != $REF)"; fi
fi

# ---- 3b. UI: rebuild + overlay the static bundle (cloud's "rebuild on box")-
if [ "$DO_UI" = 1 ]; then
  log ""
  log "── rebuild UI ─────────────────────────────────────────────"
  python3 build_ui.py
  # build_ui.py writes flow_sdk/server/static/ in the repo; ship it into the install.
  tar -C flow_sdk/server -cf - static | tar -C "$SP/flow_sdk/server" -xf -
  ok "overlaid rebuilt static bundle into the install"
fi

# ---- 4. restart (the "systemctl restart flowpad"; flow_prod runs from $HOME) -
if [ "$DO_RESTART" = 0 ]; then
  log ""; warn "--no-restart: patched files are in place; restart yourself to load them."
  exit 0
fi
log ""
log "── restart ────────────────────────────────────────────────"
flow_prod stop >/dev/null 2>&1 || true
flow_prod start 2>&1 | sed 's/^/  /' || die "flow start failed"

# ---- 5. verify (poll — server warm-boots in a few seconds) -----------------
i=0
until health_check; do
  i=$((i+1)); [ "$i" -ge 40 ] && { warn "not healthy after ${i}s — check: ($FLOW_BIN upgrade --info) and instance logs"; exit 1; }
  sleep 1
done
log ""
ok "patched server healthy on :$PORT after ${i}s"
"$FLOW_BIN" upgrade --info 2>/dev/null | sed 's/^/  /' || true
log ""
log "${c_dim}code-only patches don't change the reported version — verify behavior, not the version string (same caveat as cloud patch).${c_off}"
log "${c_dim}rollback: scripts/local_patch.sh <original-ref> -- ${PATHS[*]}   (or re-run the full local deployment to realign).${c_off}"
