#!/usr/bin/env bash
# Runs INSIDE docker/Dockerfile.install-snippet: the hub's install snippet,
# line by line, then the proof that the asset landed. Inputs: WHEEL (the
# flowpad wheel standing in for the PyPI release), HUB_TOKEN (a hub login
# token — what `flow auth login` takes), TYPEID (the published asset).
set -euo pipefail
: "${WHEEL:?}" "${HUB_TOKEN:?}" "${TYPEID:?}"
export FLOWPAD_HUB_URL="${FLOWPAD_HUB_URL:-http://host.docker.internal:8093}"

step() { echo; echo "──── $*"; }

step "uv tool install flowpad   (from $WHEEL — this tree's build of the same wheel)"
uv tool install "$WHEEL" 2>&1 | tail -3
command -v flow; uv tool list | grep flowpad

step "flow start"
flow start 2>&1 | tail -5 || true
PORT=""
for i in $(seq 1 60); do
  [ -f "$HOME/.flow/instances/prod/server.json" ] && PORT=$(python3 -c "import json;print(json.load(open('$HOME/.flow/instances/prod/server.json'))['port'])")
  [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/api/v1/graph/bootstrap" >/dev/null && break
  sleep 1
done
echo "server up on :$PORT"

step "flow auth login"
flow auth login "$HUB_TOKEN"

step "flow asset install $TYPEID   (cwd = a fresh project folder)"
mkdir -p "$HOME/Flowpad workspace/demo"
cd "$HOME/Flowpad workspace/demo"
flow asset install "$TYPEID" | tee /tmp/install.json

step "what landed"
find "$HOME/Flowpad workspace/demo" -type f | sort
echo "--- deps.json"; cat "$HOME/Flowpad workspace/demo/agentic-assets/project_manifest/deps.json"
echo "--- SKILL.md head"; head -5 "$HOME/Flowpad workspace/demo/.claude/skills/"*/SKILL.md

step "flow record search rca-demo"
flow record search rca-demo all 10 | tee /tmp/search.json

step "funding: what an agentic process on this box would run on"
curl -s "http://127.0.0.1:$PORT/api/v1/graph/compute_node/@local/llm-endpoint" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('hub_logged_in', d['hub_logged_in']); print('resolved', json.dumps(d.get('resolved'))[:400])"

step "an agentic process in the project SEES the installed skill"
PROJECT_ID=$(python3 -c "import json;print(json.load(open('/tmp/install.json'))['project_id'])")
AP=$(curl -s -X POST "http://127.0.0.1:$PORT/api/v1/graph/agentic_process" -H 'Content-Type: application/json' \
  -d "{\"worker_type\":\"claude_code\",\"pty_mode\":false,\"workdir\":\"$HOME/Flowpad workspace/demo\",\"project_id\":\"$PROJECT_ID\",\"name\":\"sees-the-skill\",\"cli_config\":{\"model\":\"anthropic/claude-haiku-4.5\"}}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "process $AP"
curl -s -X POST "http://127.0.0.1:$PORT/api/v1/graph/agentic_process/$AP/execute" -H 'Content-Type: application/json' \
  -d '{"instruction":"Use the rca-demo skill on this log, then reply with only the RCA line it prescribes:\n\nFAILED tests/test_math.py::test_divide - ZeroDivisionError: division by zero\n  File \"src/math.py\", line 12, in divide\n    return a / b\n"}' | head -c 300; echo
# A headless turn is over when its transcript carries claude's `result` line
# (the process row itself stays `running` between turns).
TRANSCRIPT=""
for i in $(seq 1 240); do
  SESSION=$(curl -s "http://127.0.0.1:$PORT/api/v1/graph/agentic_process/$AP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('session_id') or '')")
  TRANSCRIPT=$(ls "$HOME"/.claude/projects/*/"$SESSION".jsonl 2>/dev/null | head -1 || true)
  [ -n "$TRANSCRIPT" ] && grep -q '"type":"result"' "$TRANSCRIPT" && break
  sleep 2
done
echo "process ended as: $(curl -s "http://127.0.0.1:$PORT/api/v1/graph/agentic_process/$AP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('status'))")"
echo "transcript: $TRANSCRIPT"
if [ -n "$TRANSCRIPT" ]; then
  echo "--- Skill invocations:"; grep -o '"name":"Skill","input":{[^}]*}' "$TRANSCRIPT" | head -3 || true
  echo "--- skill named in the run: $(grep -c 'rca-demo' "$TRANSCRIPT") lines"
  echo "--- final assistant text:"; python3 - "$TRANSCRIPT" <<'PY'
import json,sys
last=""
for line in open(sys.argv[1]):
    try: d=json.loads(line)
    except Exception: continue
    if d.get("type")=="assistant":
        for c in (d.get("message") or {}).get("content") or []:
            if isinstance(c,dict) and c.get("type")=="text": last=c["text"]
print(last[:600])
PY
fi
