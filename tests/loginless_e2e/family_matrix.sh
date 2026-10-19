#!/usr/bin/env bash
# The loginless "hi" matrix, run INSIDE one bare container (Dockerfile.bare: the OS and the wheel,
# nothing else of ours). run.sh (MATRIX=1) starts it with the public endpoint id and the hub URL:
#
#   1. bind:     flow llm user use <id> --hub <hub>          -- the only funding the box ever gets
#   2. install:  flow wizard run llm-setup-<h> --yes          -- every harness CLI, by its wizard;
#                the wizard's CLI step must do it (an agent-rung install fails the run)
#   3. ask:      flow process start "hi" --worker <w> --model <family>:<size>   -- every cell
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
  for family in $FAMILIES; do
    for size in $SIZES; do
      start=$(date +%s)
      out="$(flow process start "$PROMPT" --worker "$worker" --model "$family:$size" 2>/tmp/cell.err)"
      rc=$?
      secs=$(( $(date +%s) - start ))
      said="$(echo "$out" | tr '\n' ' ' | cut -c1-80)"
      if [[ $rc -eq 0 && -n "${said// /}" ]]; then
        echo "PASS $worker $family:$size ${secs}s $said"
      else
        echo "FAIL $worker $family:$size ${secs}s exit=$rc $(tail -c 300 /tmp/cell.err | tr '\n' ' ')"
        failed=1
      fi
    done
  done
done
exit $failed
