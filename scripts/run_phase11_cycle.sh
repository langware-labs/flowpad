#!/usr/bin/env bash
# Phase 11: fail-closed, resumable, per-file Playwright .md.ts green gate.
#
# Required caller-owned contract (never inferred from .env.local):
#   INSTANCE          cycle-owned Alice browser instance
#   BOB_INSTANCE      cycle-owned Bob companion instance
#   FLOWPAD_HUB_URL   explicit hub shared by both instances
#   RD                cycle result directory
#   QA_DOCKER_CONTAINER disposable running container for Docker scenarios
#
# The generated .env.<instance>.local files are parsed as data by the Python
# helper; they are never sourced or executed.
#
# Resume is intentionally verdict-preserving: parseable JSON+exit artifacts,
# including blocked rc/test verdicts, are not rerun.  After a manager fix or a
# full-manager restart, use a fresh child RD instead of reusing the old one.
set -Eeuo pipefail

: "${INSTANCE:?INSTANCE is required (cycle-owned Alice instance)}"
: "${BOB_INSTANCE:?BOB_INSTANCE is required (cycle-owned Bob instance)}"
: "${FLOWPAD_HUB_URL:?FLOWPAD_HUB_URL is required}"
: "${RD:?RD is required (Phase 11 result directory)}"
: "${QA_DOCKER_CONTAINER:?QA_DOCKER_CONTAINER is required}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO/scripts/phase11_cycle_report.py"
SCENARIOS="$REPO/ui/tests/manual_regression"
RESULTS_ROOT="$SCENARIOS/_results"
RD="$(python3 "$HELPER" validate-run-dir --results-root "$RESULTS_ROOT" --run-dir "$RD")"
MANIFEST="$RD/phase11-manifest.json"
PREFLIGHT="$RD/phase11-preflight.json"
SUMMARY="$RD/phase11-summary.json"

mkdir -p "$RD"

log() {
  printf '[phase11] %s\n' "$*" >&2
}

emit_blocked_summary() {
  local reason="$1"
  trap - ERR
  set +e
  python3 "$HELPER" aggregate \
    --repo "$REPO" \
    --run-dir "$RD" \
    --manifest "$MANIFEST" \
    --output "$SUMMARY" \
    --infra "$reason" >&2
  local aggregate_rc=$?
  if [ "$aggregate_rc" -eq 0 ] && [ -s "$SUMMARY" ]; then
    cat "$SUMMARY"
  else
    printf '{"phase":11,"expected_files":0,"reported_files":0,"gate":"blocked","infra":["summary_generation_failed"],"totals":{},"files":[],"tests":[]}\n'
  fi
  exit 2
}

on_unexpected_error() {
  local line="$1"
  log "unexpected runner command failure at line $line"
  emit_blocked_summary "runner_command_failed"
}
trap 'on_unexpected_error "$LINENO"' ERR

python3 "$HELPER" manifest \
  --repo "$REPO" \
  --root "$SCENARIOS" \
  --output "$MANIFEST"

if [ "$INSTANCE" = "$BOB_INSTANCE" ]; then
  log "Alice and Bob instances must be distinct"
  emit_blocked_summary "alice_and_bob_instances_not_distinct"
fi

if ! python3 "$HELPER" preflight \
  --repo "$REPO" \
  --instance "$INSTANCE" \
  --bob-instance "$BOB_INSTANCE" \
  --hub-url "$FLOWPAD_HUB_URL" \
  --output "$PREFLIGHT"; then
  emit_blocked_summary "instance_or_hub_preflight_failed"
fi

ALICE_API="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.alice.api_url)"
ALICE_APP="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.alice.app_url)"
ALICE_BE_PORT="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.alice.backend_port)"
ALICE_FE_PORT="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.alice.frontend_port)"
ALICE_EMAIL="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.alice.email)"
QA_ALICE_HUB_ID="$(python3 "$HELPER" get --input "$PREFLIGHT" --key hub.alice_user_id)"
BOB_API="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.bob.api_url)"
BOB_EMAIL="$(python3 "$HELPER" get --input "$PREFLIGHT" --key instances.bob.email)"
QA_BOB_HUB_ID="$(python3 "$HELPER" get --input "$PREFLIGHT" --key hub.bob_user_id)"

# Passwords are read from the two generated env files without sourcing them.
# Command substitution captures them; the runner never prints either value.
ALICE_PW="$(python3 "$HELPER" env-value --repo "$REPO" --instance "$INSTANCE" --key FLOWPAD_CLOUD_USER_PASSWORD)"
BOB_PW="$(python3 "$HELPER" env-value --repo "$REPO" --instance "$BOB_INSTANCE" --key FLOWPAD_CLOUD_USER_PASSWORD)"

current_category=""
category_ready=0

ensure_category_reset() {
  local category="$1"
  local category_hash marker raw reset_log runtime reset_rc
  category_hash="$(python3 "$HELPER" category-hash --manifest "$MANIFEST" --category "$category")"
  marker="$RD/phase11-categories/$category/reset.json"
  raw="$RD/phase11-categories/$category/reset.raw.json"
  reset_log="$RD/phase11-categories/$category/reset.stderr.log"
  runtime="$RD/phase11-categories/$category/runtime.json"
  mkdir -p "$(dirname "$marker")"

  if python3 "$HELPER" validate-reset \
    --input "$marker" \
    --instance "$INSTANCE" \
    --port "$ALICE_BE_PORT" \
    --category "$category" \
    --category-hash "$category_hash" >/dev/null 2>&1; then
    log "resume category $category (validated backend-reset marker)"
  else
    log "reset category $category (backend-only, keychain preserved)"
    rm -f "$raw"
    set +e
    (
      cd "$REPO"
      FLOW_INSTANCE="$INSTANCE" FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" \
        uv run flow instance reset "$INSTANCE" \
          --backend-only --keep-keychain --json
    ) >"$raw" 2>"$reset_log"
    reset_rc=$?
    set -e
    if [ "$reset_rc" -ne 0 ]; then
      emit_blocked_summary "category_backend_reset_failed"
    fi
    if ! python3 "$HELPER" record-reset \
      --input "$raw" \
      --output "$marker" \
      --instance "$INSTANCE" \
      --port "$ALICE_BE_PORT" \
      --category "$category" \
      --category-hash "$category_hash"; then
      emit_blocked_summary "category_backend_reset_json_invalid"
    fi
    rm -f "$raw"
  fi

  # Singular, immediate runtime check after either a fresh reset or resume.
  if ! python3 "$HELPER" runtime \
    --api-url "$ALICE_API" \
    --app-url "$ALICE_APP" \
    --email "$ALICE_EMAIL" \
    --hub-url "$FLOWPAD_HUB_URL" \
    --expected-user-id "$QA_ALICE_HUB_ID" \
    --output "$runtime"; then
    emit_blocked_summary "category_runtime_validation_failed"
  fi

}

# Keep the manifest on a dedicated descriptor. Commands executed by a loop
# inherit its stdin; when the manifest lived on fd 0, the category reset CLI
# consumed every row after the first and the runner silently aggregated the
# remainder as missing.
while IFS=$'\t' read -r category file config source_sha config_sha <&3; do
  scenario_rel="${file#ui/tests/manual_regression/}"
  artifact="$RD/phase11-files/${scenario_rel%.md.ts}"
  report="$artifact/report.json"
  exit_capture="$artifact/exit.json"
  assessment="$artifact/assessment.json"
  stdout_log="$artifact/playwright.stdout.log"
  clear_json="$artifact/desktop-clear.json"
  output_dir="$artifact/playwright-output"
  config_from_ui="${config#ui/}"
  file_from_ui="${file#ui/}"
  mkdir -p "$artifact"

  if python3 "$HELPER" assess \
    --repo "$REPO" \
    --file "$file" \
    --source-sha256 "$source_sha" \
    --config-sha256 "$config_sha" \
    --report "$report" \
    --exit "$exit_capture" \
    --output "$assessment" >/dev/null 2>&1; then
    log "resume $scenario_rel (parseable JSON + exit capture)"
    continue
  fi

  if [ "$current_category" != "$category" ]; then
    current_category="$category"
    category_ready=0
  fi
  if [ "$category_ready" -eq 0 ]; then
    ensure_category_reset "$category"
    category_ready=1
  fi

  # Incomplete prior artifacts cannot serve as a verdict.  Preserve the log,
  # but remove stale machine files before the new invocation.
  rm -f "$report" "$exit_capture" "$assessment" "$clear_json"

  log "clear + run $scenario_rel"
  if ! python3 "$HELPER" clear --api-url "$ALICE_API" --output "$clear_json"; then
    emit_blocked_summary "desktop_clear_or_bootstrap_validation_failed"
  fi

  if [[ "$scenario_rel" == terminal/sandbox_*.md.ts ]]; then
    provider_json="$artifact/providers.json"
    if ! python3 "$HELPER" providers \
      --api-url "$ALICE_API" \
      --require-sandbox \
      --output "$provider_json"; then
      emit_blocked_summary "sandbox_provider_validation_failed"
    fi
  fi

  set +e
  (
    # ERR is inherited because the runner uses `set -E`. A normal Playwright
    # test failure is data for the per-file assessment, not an unexpected
    # runner failure; keep the outer trap from replacing the test log/exit
    # code with an aggregate summary.
    trap - ERR
    cd "$REPO/ui"
    env \
      INSTANCE="$INSTANCE" \
      BOB_INSTANCE="$BOB_INSTANCE" \
      FLOW_INSTANCE="$INSTANCE" \
      QA_FLOW_INSTANCE="$INSTANCE" \
      FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" \
      QA_HUB_URL="$FLOWPAD_HUB_URL" \
      LOCAL_SERVER_PORT="$ALICE_BE_PORT" \
      VITE_PORT="$ALICE_FE_PORT" \
      VITE_API_URL="$ALICE_API" \
      API_URL="$ALICE_API" \
      QA_API_URL="$ALICE_API" \
      APP_URL="$ALICE_APP" \
      SHARE_INST_1="$INSTANCE" \
      SHARE_INST_2="$BOB_INSTANCE" \
      ALICE_EMAIL="$ALICE_EMAIL" \
      ALICE_PW="$ALICE_PW" \
      BOB_EMAIL="$BOB_EMAIL" \
      BOB_PW="$BOB_PW" \
      QA_ALICE_API="$ALICE_API" \
      QA_ALICE_EMAIL="$ALICE_EMAIL" \
      QA_ALICE_PW="$ALICE_PW" \
      QA_BOB_API="$BOB_API" \
      QA_BOB_EMAIL="$BOB_EMAIL" \
      QA_BOB_PW="$BOB_PW" \
      QA_BOB_HUB_ID="$QA_BOB_HUB_ID" \
      PLAYWRIGHT_JSON_OUTPUT_NAME="$report" \
      npx playwright test \
        --config "$config_from_ui" \
        "$file_from_ui" \
        --workers=1 \
        --reporter=json \
        --output "$output_dir" \
        </dev/null
  ) >"$stdout_log" 2>&1
  playwright_rc=$?
  set -e

  if ! python3 "$HELPER" write-exit \
    --output "$exit_capture" \
    --file "$file" \
    --source-sha256 "$source_sha" \
    --config-sha256 "$config_sha" \
    --exit-code "$playwright_rc"; then
    emit_blocked_summary "playwright_exit_capture_failed"
  fi

  if ! python3 "$HELPER" assess \
    --repo "$REPO" \
    --file "$file" \
    --source-sha256 "$source_sha" \
    --config-sha256 "$config_sha" \
    --report "$report" \
    --exit "$exit_capture" \
    --output "$assessment"; then
    emit_blocked_summary "playwright_no_machine_verdict"
  fi

  verdict="$(python3 "$HELPER" get --input "$assessment" --key verdict)"
  log "verdict $scenario_rel: $verdict (exit=$playwright_rc)"
done 3< <(python3 "$HELPER" manifest-lines --manifest "$MANIFEST")

python3 "$HELPER" aggregate \
  --repo "$REPO" \
  --run-dir "$RD" \
  --manifest "$MANIFEST" \
  --output "$SUMMARY"

gate="$(python3 "$HELPER" get --input "$SUMMARY" --key gate)"
cat "$SUMMARY"
if [ "$gate" = "passed" ]; then
  exit 0
fi
exit 1
