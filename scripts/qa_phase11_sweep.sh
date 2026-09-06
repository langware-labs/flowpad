#!/usr/bin/env bash
# Phase 11 sweep driver: per-category `flow instance reset`, per-file DB clear,
# Playwright JSON verdict + console-error sink.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INSTANCE="${INSTANCE:-qa-1}"
TS="${TS:?TS required}"
OUT="$ROOT/ui/tests/manual_regression/_results/$TS"
SINKDIR="$OUT/console"
mkdir -p "$OUT" "$SINKDIR"

USER_BE=$(grep -E '^LOCAL_SERVER_PORT=' "$ROOT/.env.local" | cut -d= -f2 | tr -d ' ')
QA_BE=$(uv run flow instance ctl port "$INSTANCE" --role backend)
[ -n "$QA_BE" ] || { echo "FATAL: no live backend port for $INSTANCE — refusing to clear"; exit 1; }
[ "$QA_BE" != "$USER_BE" ] || { echo "FATAL: resolved the user's backend ($USER_BE) — refusing to clear"; exit 1; }
QA_FE=$(uv run flow instance ctl port "$INSTANCE" --role frontend)
[ -n "$QA_FE" ] || { echo "FATAL: no live frontend port for $INSTANCE"; exit 1; }

GUARD="$ROOT/ui/tests/manual_regression/_shared/console-guard.cjs"
[ -f "$GUARD" ] || { echo "FATAL: console guard missing"; exit 1; }

echo "sweep: instance=$INSTANCE backend=$QA_BE frontend=$QA_FE out=$OUT"

CATS="${CATS:-}"
if [ -z "$CATS" ]; then
  CATS=$(cd ui/tests/manual_regression && for d in */; do
    [ -n "$(find "$d" -maxdepth 1 -name '*.md.ts' -print -quit)" ] && basename "$d"
  done | sort)
fi

for cat in $CATS; do
  echo "=== CATEGORY $cat ==="
  if ! uv run flow instance reset "$INSTANCE" --keep-keychain --json 2>&1 | tee /dev/stderr | grep -q '"ready": true'; then
    echo "CATEGORY_RESET_FAILED $cat"
    echo "{\"category\":\"$cat\",\"error\":\"reset_failed\"}" >> "$OUT/phase11-errors.jsonl"
    continue
  fi
  # Stop the QA instance auto-indexing. A cold instance's first project selection
  # kicks a ~49s walk (measured: 758 files / 48816ms) that the test then races —
  # the real cause of the "cumulative degradation" a per-file reset was reached for.
  # Removing the contention beats cold-booting before every file, which destroys the
  # warm state the persistence/tab-state tests need. Re-applied here because a full
  # reset recreates preferences.json.
  python3 - "$INSTANCE" <<'PYEOF'
import json, pathlib, sys
p = pathlib.Path.home() / ".flow/instances" / sys.argv[1] / "preferences.json"
d = json.loads(p.read_text()) if p.exists() else {}
d["preferences.auto_index.enabled"] = False
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(d, indent=2))
PYEOF

  for f in $(cd "ui/tests/manual_regression/$cat" && ls *.md.ts 2>/dev/null | sort); do
    base="${f%.md.ts}"
    jsonf="$OUT/phase11--$cat--$base.json"
    sinkf="$SINKDIR/$cat--$base.jsonl"
    if [ -f "$jsonf" ]; then echo "SKIP(done) $cat/$base"; continue; fi
    : > "$sinkf"

    CLR=$(curl -s -X POST "http://localhost:$QA_BE/api/v1/graph/compute_node/@local/desktop-db/clear")
    if ! echo "$CLR" | grep -q '"backup_path"'; then
      echo "DB_CLEAR_FAILED $cat/$base: $CLR"
      echo "{\"category\":\"$cat\",\"file\":\"$base\",\"error\":\"db_clear_failed\"}" >> "$OUT/phase11-errors.jsonl"
      continue
    fi
    for i in $(seq 1 30); do
      curl -s "http://localhost:$QA_BE/api/v1/graph/bootstrap" 2>/dev/null | grep -q '"types"' && break
      sleep 1
    done
    # Wait for the indexer to go idle. A cold instance's FIRST project selection
    # kicks a ~49s auto-index (measured: 758 files / 48816ms), and the sweep resets
    # per category — so without this every category's first file raced that index
    # and its timeouts were contention artifacts, not verdicts.
    for i in $(seq 1 120); do
      AS=$(curl -s "http://localhost:$QA_BE/api/v1/graph/compute_node/@local/fs-records/activity-status" 2>/dev/null)
      echo "$AS" | grep -q '"data": *null' && break
      echo "$AS" | grep -q '"data":null' && break
      sleep 1
    done

    echo "--- RUN $cat/$base"
    ( cd ui && VITE_PORT="$QA_FE" \
        FLOW_INSTANCE="$INSTANCE" LOCAL_SERVER_PORT="$QA_BE" \
        PW_CONSOLE_SINK="$sinkf" \
        NODE_OPTIONS="--require $GUARD" \
        PLAYWRIGHT_JSON_OUTPUT_NAME="$jsonf" \
        npx playwright test --config "tests/manual_regression/$cat/playwright.config.ts" "$f" --reporter=json > /dev/null 2>"$OUT/phase11--$cat--$base.stderr" )
    code=$?
    nerr=$(wc -l < "$sinkf" | tr -d ' ')
    echo "RESULT $cat/$base exit=$code console_errors=$nerr"
    echo "{\"category\":\"$cat\",\"file\":\"$base\",\"exit\":$code,\"console_errors\":$nerr}" >> "$OUT/phase11-runs.jsonl"
  done
done
echo "SWEEP_DONE"
