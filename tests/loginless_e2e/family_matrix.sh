#!/usr/bin/env bash
# The loginless "hi" matrix, run INSIDE one bare container (Dockerfile.bare: the OS and the wheel,
# nothing else of ours). run.sh (MATRIX=1) starts it with the public endpoint id and the hub URL:
#
#   1. bind:     flow llm user use <id> --hub <hub>          -- the only funding the box ever gets
#   2. install:  flow wizard run llm-setup-<h> --yes          -- every harness CLI, by its wizard;
#                the wizard's CLI step must do it (an agent-rung install fails the run)
#   3. ask:      flow process start "hi" --worker <w> --model <fixture-resolved slug>
#
# One line per cell: PASS|FAIL <worker> <family>:<size> <secs>s <detail>. Exit 1 if anything failed.
set -uo pipefail

ID="$1"
HUB="$2"
WORKERS="${WORKERS:-claude_code codex copilot opencode deepagents}"
FAMILIES="${FAMILIES:-kimi glm openai claude}"
SIZES="${SIZES:-sm md lg}"
PROMPT="${PROMPT:-hi}"
failed=0
rig_dir="$(cd "$(dirname "$0")" && pwd)"
# Resolve and validate the fixture before installing anything. These labels are not SDK model syntax.
cells="$(python "$rig_dir/make_matrix_endpoint.py" --cells "$FAMILIES" "$SIZES")" || exit 1
selected_workers=""
worker_count=0
for worker in $WORKERS; do
  case "$worker" in claude_code|codex|copilot|opencode|deepagents) ;; *) echo "FAIL unknown worker: $worker"; exit 1 ;; esac
  case " $selected_workers " in *" $worker "*) echo "FAIL duplicate worker: $worker"; exit 1 ;; esac
  selected_workers="$selected_workers $worker"
  worker_count=$((worker_count + 1))
done
if [[ -z "$selected_workers" ]]; then echo "FAIL no workers selected"; exit 1; fi
for wizard in ${WIZARDS:-claude-code codex copilot opencode}; do
  case "$wizard" in claude-code|codex|copilot|opencode) ;; *) echo "WIZARD FAIL unknown wizard: $wizard"; exit 1 ;; esac
done
model_count=0
while read -r family size slug; do
  model_count=$((model_count + 1))
done <<< "$cells"
expected=$((worker_count * model_count))
attempted=0
cell_err="$(mktemp)"
trap 'rm -f "$cell_err"' EXIT

flow llm user use "$ID" --hub "$HUB" || exit 1

for wizard in ${WIZARDS:-claude-code codex copilot opencode}; do
  out="$(flow wizard run "llm-setup-$wizard" --yes 2>&1)"
  rc=$?
  echo "$out" | sed "s/^/  [$wizard] /" >&2
  if [[ $rc -ne 0 ]]; then
    echo "WIZARD FAIL $wizard exit=$rc"
    failed=1
  elif ! echo "$out" | grep -q "step install: OK by cli"; then
    echo "WIZARD FAIL $wizard not installed by its CLI step"
    failed=1
  else
    echo "WIZARD PASS $wizard"
  fi
done

for worker in $WORKERS; do
  while read -r family size slug; do
      attempted=$((attempted + 1))
      start=$(date +%s)
      model="$slug"
      if [[ "$worker" == "opencode" ]]; then model="openrouter/$slug"; fi
      # The CLI captures piped stdin for its log; it must not consume this loop's cells.
      out="$(flow process start "$PROMPT" --worker "$worker" --model "$model" </dev/null 2>"$cell_err")"
      rc=$?
      secs=$(( $(date +%s) - start ))
      process_id="$(sed -n 's/.*running agentic process \(agentic_process-[0-9a-f-]*\).*/\1/p' "$cell_err" | tail -n 1)"
      evidence=""
      if [[ $rc -eq 0 && -n "$process_id" ]]; then
        evidence="$(python "$rig_dir/worker_matrix.py" --verify-cli "$process_id" "$model" </dev/null 2>"$cell_err")"
        rc=$?
      else
        rc=1
      fi
      if [[ $rc -eq 0 ]]; then
        echo "PASS $worker $family:$size ${secs}s $evidence"
      else
        # Raw CLI exceptions can carry injected credentials; never copy them into the report.
        echo "FAIL $worker $family:$size ${secs}s exit=$rc process=${process_id:-none} no verified assistant completion"
        failed=1
      fi
  done <<< "$cells"
done
if [[ $attempted -ne $expected ]]; then
  echo "FAIL inventory attempted=$attempted expected=$expected"
  failed=1
fi
echo "MATRIX attempted=$attempted expected=$expected"
exit $failed
