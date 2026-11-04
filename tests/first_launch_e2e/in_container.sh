#!/usr/bin/env bash
# The clean-container proof, run as PID 1.
#
#   index -> llm-setup wizard + trigger -> a tab opens -> app.tab.ready -> trigger fires
#   -> setup popup -> Start -> asked before each install -> Install -> tools installed
#
# Every assertion below is about a LINK in that chain, not just the end state:
# "python3 and git now exist" would also pass if something else installed them.
#
# NOTE: there is deliberately no python3 in this image, so every JSON read here
# goes through `node`. Reaching for `python3 -c` (as docker/run_realtime_tests.sh
# does) would install-by-accident the very thing under test.
set -uo pipefail

PORT="${LOCAL_SERVER_PORT:-9712}"
API="http://localhost:${PORT}/api/v1"
BUDGET_S="${WIZARD_BUDGET_S:-900}"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILED=1; }
banner() { echo; echo "===== $* ====="; }
FAILED=0

# `node -e` reading stdin as JSON. Prints "" on any parse/lookup failure so a
# caller compares against a value rather than crashing.
jq_() { node -e '
  let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
    try { const d = JSON.parse(raw); const fn = new Function("d", "return (" + process.argv[1] + ")");
          const v = fn(d); process.stdout.write(v === undefined || v === null ? "" : String(v)); }
    catch (e) { process.stdout.write(""); }
  });' "$1"; }

have() { command -v "$1" >/dev/null 2>&1 && echo yes || echo no; }

# The backend refuses any request without its cookie-gate token; `flow` hands it out.
GATE=""
gcurl() { curl -H "X-Cookie-Gate: ${GATE}" "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
banner "A  pre-state — the test's own precondition"
# If this fails, nothing after it proves anything: a wizard step whose
# precondition is already satisfied skips, and the run would be green and empty.
PY_BEFORE=$(have python3); GIT_BEFORE=$(have git)
echo "python3=${PY_BEFORE}  git=${GIT_BEFORE}"
[ "$PY_BEFORE" = "no" ] && pass "python3 absent" || fail "python3 already present — the wizard would skip"
[ "$GIT_BEFORE" = "no" ] && pass "git absent"     || fail "git already present — the wizard would skip"
[ "$FAILED" = "1" ] && { echo; echo "RESULT: FAIL (dirty image)"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
banner "B  start the backend"
flow start service
GATE=$(flow auth get-cookie-gate)
for i in $(seq 1 90); do
  gcurl -fsS "${API}/health/status" >/dev/null 2>&1 && break
  sleep 1
done
if gcurl -fsS "${API}/health/status" >/dev/null 2>&1; then pass "backend healthy on :${PORT}"
else fail "backend never became healthy"; echo "RESULT: FAIL"; exit 1; fi

# ─────────────────────────────────────────────────────────────────────────────
banner "C  fund the installer agent"
# The two funding paths are MUTUALLY EXCLUSIVE, and that is not a preference.
# Cloud login wins the harness binding outright: once the instance is logged in,
# `ANTHROPIC_BASE_URL` is pinned to the hub endpoint's /invoke URL and the
# worker never sees OpenRouter, whatever OPENROUTER_API_KEY says. Verified in
# the container by reading the worker's own /proc environ. So a run that means
# to spend an OpenRouter key must NOT log in.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  # STORE the key; do not merely export it. A worker spawn resolves its funding
  # with `allow_environment=False` on purpose — an environment variable is a
  # convenience for in-process calls, not a statement about what this box is
  # configured to spend — so a bare OPENROUTER_API_KEY funds exactly nothing and
  # the agent dies with "Not logged in · Please run /login". Storing it is what
  # makes the api_key source ELIGIBLE (`_key_sources` keys off the stored
  # secret; there is no row to create, the endpoint is projected).
  #
  # Written THROUGH THE BACKEND, not from a second process. The store is one
  # file that the server holds a full copy of: a write from any other process is
  # clobbered by the server's next write of a copy that never had the key.
  # Seeding after boot survived to here and then vanished mid-run (step 1's
  # agent spawned, step 2 died with "no openrouter key is stored"); seeding
  # before boot was gone by the time the server finished starting. The only
  # writer that cannot lose the race is the server itself.
  gcurl -fsS -X POST "${API}/graph/compute_node/secrets" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"lm_api.openrouter\",\"value\":\"${OPENROUTER_API_KEY}\",\"description\":\"first-launch e2e\"}" \
    >/dev/null 2>&1

  # And read back through the backend too, for the same reason.
  SEEDED=$(gcurl -fsS "${API}/graph/compute_node/secrets" 2>/dev/null \
    | jq_ '((d.data||d).secrets||(d.data||d)||[]).filter(x=>(x.name||x)==="lm_api.openrouter").length ? "yes" : "no"')
  [ "$SEEDED" = "yes" ] && pass "OpenRouter key stored and read back — the agent has a source to spend" \
                        || fail "the key did not survive the round trip; the installer agent has no funding"
  [ "$SEEDED" = "yes" ] || { echo; echo "RESULT: FAIL (no funding)"; exit 1; }

  # RESTART so the server loads the store it now has. Writing through the
  # backend gets the key onto disk, but the funding resolver reads a view taken
  # at startup: the FIRST agent spawn died with "Not logged in · Please run
  # /login" having run zero commands, while the SECOND — after something had
  # refreshed that view — installed fine. Same symptom every run, always the
  # first step, which is what gives it away as staleness rather than flakiness.
  #
  # This also matches how a real machine gets here: the key is configured, and
  # THEN the app runs. `app.ready` is emitted on every boot and the trigger has
  # not fired yet, so the chain below is unaffected.
  flow stop >/dev/null 2>&1 || true
  sleep 3
  flow start service
  for i in $(seq 1 90); do gcurl -fsS "${API}/health/status" >/dev/null 2>&1 && break; sleep 1; done
  gcurl -fsS "${API}/health/status" >/dev/null 2>&1 \
    && pass "backend restarted with the key in its store" \
    || { fail "backend did not come back after seeding"; echo "RESULT: FAIL"; exit 1; }
elif [ -n "${FLOWPAD_CLOUD_USER_EMAIL:-}" ]; then
  gcurl -fsS -X POST "${API}/cloud/login" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
  WHO=$(gcurl -fsS "${API}/cloud/status" 2>/dev/null | jq_ 'd.data.user.email')
  [ -n "$WHO" ] && pass "logged in as ${WHO}" || fail "cloud login did not take"
  gcurl -fsS -X POST "${API}/cloud/ws/connect" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
else
  fail "FLOWPAD_CLOUD_USER_EMAIL unset — the installer agent has no LLM to spend"
fi

# ─────────────────────────────────────────────────────────────────────────────
banner "D  the app becomes ready"
# `first_bootstrap_served` is set ONLY by this route — not by health, not by the
# CLI. There is no browser in here, so the test plays the client's part.
BOOT=$(gcurl -fsS "${API}/graph/bootstrap" 2>/dev/null | wc -c)
[ "$BOOT" -gt 100 ] && pass "bootstrap served (${BOOT} bytes)" || fail "bootstrap did not answer"

# ─────────────────────────────────────────────────────────────────────────────
banner "E  the chain — a person opens the app, sees setup, and says Install"
# Today's first launch (FLOWPAD-2111, 8e3a518b1): the app TAB becoming ready emits
# `app.tab.ready`; the llm-setup wizard's own trigger ("First-time setup",
# fire_once) runs `builtin_run_llm_setup`. A person is watching, so it puts the
# popup in front of them and STOPS; they press Start, and every missing tool is
# asked about (Install / Skip) before anything is installed. The old app.ready ->
# "Developer toolchain" chain installed silently and no longer ships.
#
# There is no browser in here, so the test plays the tab: one socket that sends
# the `browser_context` frame the UI sends on its first route, held open for the
# whole run (an ask nobody can be shown is abandoned after a presence grace).
open_tab() {  # $1 = log file. Prints the pid.
  node -e '
    const [port, gate, log] = process.argv.slice(1);
    const fs = require("fs");
    const id = require("crypto").randomUUID();
    const ws = new WebSocket(`ws://localhost:${port}/api/v1/connect/ws/${id}?cookie-gate=${gate}`);
    ws.onopen = () => ws.send(JSON.stringify({ message_type: "browser_context",
      context: { url: `http://localhost:${port}/dock` } }));
    ws.onmessage = (m) => fs.appendFileSync(log, String(m.data) + "\n");
    ws.onclose = () => { fs.appendFileSync(log, "CLOSED\n"); process.exit(0); };
    setInterval(() => {}, 1 << 30);
  ' "$PORT" "$GATE" "$1" >/dev/null 2>&1 &
  echo $!
}
SETUP_NAME="llm-setup"
TRIGGER_NAME="First-time setup"
trigger_counter() {
  gcurl -fsS "${API}/graph/trigger" 2>/dev/null \
    | jq_ "(d.data||d).filter(r=>r.name===\"${TRIGGER_NAME}\").map(r=>r.counter)[0]"
}

: > /tmp/tab.log
TAB_PID=$(open_tab /tmp/tab.log)
EVENT_ID=""; COUNTER=""; POPUP=""
DEADLINE=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # The backend's own record of the envelope it emitted. NOT `/debug/recent_events`: that ring
  # holds forwarded patterns only (graph_workflow.*, ingest.*.sync.*), never app.tab.ready. And
  # not the trigger's fire log either, which is the other half of the causal join below.
  [ -z "$EVENT_ID" ] && EVENT_ID=$(grep -ho '\[app.tab.ready\] emitted event_id=[0-9a-f-]*' \
      "${FLOWPAD_TEST_SANDBOX:-/tmp}"/.flow/instances/*/logs/server/*.log 2>/dev/null | head -1 | sed 's/.*event_id=//')
  COUNTER=$(trigger_counter)
  grep -q '"open_wizard_popup"' /tmp/tab.log && POPUP=yes
  [ -n "$EVENT_ID" ] && [ "${COUNTER:-0}" = "1" ] && [ -n "$POPUP" ] && break
  sleep 2
done
[ -n "$EVENT_ID" ] && pass "app.tab.ready emitted for the open tab (event_id=${EVENT_ID})" \
                   || fail "no app.tab.ready envelope was observed"
[ "${COUNTER:-0}" = "1" ] && pass "trigger '${TRIGGER_NAME}' fired exactly once" \
                          || fail "trigger counter is '${COUNTER:-unset}', expected 1"
[ -n "$POPUP" ] && pass "the setup popup was put in front of the person (open_wizard_popup)" \
                || fail "the tab never got the setup popup"

WIZ_ID=$(gcurl -fsS "${API}/graph/wizard" 2>/dev/null \
  | jq_ "(d.data||d).filter(w=>w.name===\"${SETUP_NAME}\").map(w=>w.id)[0]")
[ -n "$WIZ_ID" ] || { fail "the ${SETUP_NAME} wizard is not indexed"; echo "RESULT: FAIL"; exit 1; }

# Start: the popup's own button. It awaits the whole run, so it runs beside the
# person answering the questions it raises.
rm -f /tmp/start.json
( gcurl -sS -X POST "${API}/graph/wizard/${WIZ_ID}/start" -H 'Content-Type: application/json' -d '{}' \
    > /tmp/start.json.part 2>&1; mv /tmp/start.json.part /tmp/start.json ) &
START_PID=$!

ANSWERED=""; ANSWERED_IDS=""; CHIP_SAW_IT=""; LIST_SAW_IT=""
ACT_PATH=$(gcurl -fsS "${API}/graph/wizard" 2>/dev/null | jq_ "(d.data||d).filter(w=>w.name===\"${SETUP_NAME}\").map(w=>w.activity_path)[0]")
DEADLINE=$(( $(date +%s) + BUDGET_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ] && [ ! -f /tmp/start.json ]; do
  # The run PLANS first (core/wizard/plan.py) and puts every missing tool to the person as
  # ONE question whose `items` are the asks — the popup's ticked checkboxes. A fresh user leaves
  # them ticked and presses Install: `{<item path>: {}}` for each approval (AskItems.tsx).
  QS=$(gcurl -fsS "${API}/ask" 2>/dev/null)
  for QID in $(printf '%s' "$QS" | jq_ '(((d.data||d).questions)||[]).map(q=>q.id).join(" ")'); do
    case " $ANSWERED_IDS " in *" $QID "*) continue;; esac
    Q=$(printf '%s' "$QS" | jq_ "JSON.stringify((((d.data||d).questions)||[]).find(q=>q.id===\"${QID}\"))")
    OPS=$(printf '%s' "$Q" | jq_ '(d.items&&d.items.length) ? d.items.map(i=>i.op+":"+(i.kind||"")).join(" ") : d.op+":"+(d.kind||"")')
    BODY=$(printf '%s' "$Q" | jq_ 'JSON.stringify({value: (d.items&&d.items.length)
        ? Object.fromEntries(d.items.filter(i=>i.kind==="confirm").map(i=>[i.path,{}]))
        : (d.kind==="confirm" ? {} : null)})')
    case "$OPS" in *:confirm*) ;; *) echo "  unexpected question ${OPS} — a fresh user would not know what to type"; ANSWERED_IDS="$ANSWERED_IDS $QID"; continue;; esac
    if gcurl -fsS -X POST "${API}/ask/${QID}/answer" -H 'Content-Type: application/json' -d "$BODY" >/dev/null 2>&1; then
      echo "  answered Install: ${OPS}"
      ANSWERED="$ANSWERED $OPS"; ANSWERED_IDS="$ANSWERED_IDS $QID"
    fi
  done
  # Visibility: the popup subscribes to the wizard's OWN activity address (`Wizard.activity_path`),
  # so that is where a person sees the run. The unscoped list (the footer chip) is logged beside it.
  if [ -z "$CHIP_SAW_IT" ]; then
    # Asked the two ways the popup asks (useWizardRun.ts): scoped to the wizard — a run a person
    # started reports there — and unscoped, where an unattended run reports.
    NODE=$(gcurl -fsS "${API}/activity/${ACT_PATH}?subject_entity=wizard-${WIZ_ID}" 2>/dev/null)
    case "$NODE" in *'"state"'*) ;; *) NODE=$(gcurl -fsS "${API}/activity/${ACT_PATH}" 2>/dev/null);; esac
    case "$NODE" in *'"state"'*) CHIP_SAW_IT=yes; echo "  activity ${ACT_PATH}: $(printf '%s' "$NODE" | jq_ 'JSON.stringify({state:(d.data||d).state,kids:((d.data||d).children||[]).map(c=>c.name+":"+c.state)})' | cut -c1-200)";; esac
  fi
  [ -z "$LIST_SAW_IT" ] && gcurl -fsS "${API}/activity" 2>/dev/null | grep -q "wizard-${SETUP_NAME}" && LIST_SAW_IT=yes
  sleep 3
done
wait "$START_PID" 2>/dev/null

case "$ANSWERED" in *ask-install-python*) pass "asked before installing Python, and the person said Install" ;;
                    *) fail "never asked about Python (answered:${ANSWERED:- none})" ;; esac
case "$ANSWERED" in *ask-install-git*)    pass "asked before installing Git, and the person said Install" ;;
                    *) fail "never asked about Git (answered:${ANSWERED:- none})" ;; esac

SOURCE_RC=$(jq_ '((d.data||d).llm_source||{}).exit_code' < /tmp/start.json 2>/dev/null)
echo "  start: $(jq_ 'JSON.stringify({source:((d.data||d).llm_source||{}).detail, ok:(d.data||d).wizard.ok, detail:(d.data||d).wizard.detail})' < /tmp/start.json 2>/dev/null | cut -c1-400)"
[ "$SOURCE_RC" = "0" ] && pass "Start settled the LLM source (the stored OpenRouter key)" \
                          || fail "Start did not settle an LLM source: $(head -c 300 /tmp/start.json 2>/dev/null)"

# The OUTCOME from the durable record, as before: `run_state` is written when the run settles.
# The OUTCOME from the durable record: `run_state.result` is the stored WizardResult; run-detail
# serves the same record with every step (nested wizards included).
WIZ=$(gcurl -fsS "${API}/graph/wizard" 2>/dev/null)
RUN_RC=$(printf '%s' "$WIZ" | jq_ "(d.data||d).filter(w=>w.name===\"${SETUP_NAME}\").map(w=>((w.run_state||{}).result||{}).exit_code)[0]")
DETAIL=$(gcurl -fsS "${API}/graph/wizard/${WIZ_ID}/run-detail" 2>/dev/null)
RUN_STEPS=$(printf '%s' "$DETAIL" | jq_ 'Object.entries(((d.data||d).result||{}).steps||{}).map(([k,v])=>k+":"+v.exit_code+(v.ran?"":"(already there)")+(v.exit_code===0?"":"("+String(v.detail||"").slice(0,160)+")")).join(" ")')
case "$RUN_RC" in
  0)  pass "the setup run completed: ${RUN_STEPS}" ;;
  "") fail "the setup wizard never recorded a run at all (run_state.result is empty)" ;;
  *)    fail "the setup run did not finish ok: ${RUN_STEPS}" ;;
esac
[ "$CHIP_SAW_IT" = "yes" ] && pass "the run reported live at the address the popup watches (${ACT_PATH})" \
                           || fail "the run never reported at ${ACT_PATH} — the person watching the popup would have seen nothing"
echo "  (unscoped activity list showed it: ${LIST_SAW_IT:-no})"

# The causal join: the trigger's fire log records the envelope that caused it.
LOG=$(gcurl -fsS "${API}/graph/trigger/fires?limit=500" 2>/dev/null)
CAUSE_ID=$(printf '%s' "$LOG" | jq_ "(d.data||d).filter(r=>r.trigger&&r.rule_name===\"${TRIGGER_NAME}\"&&r.cause_tag===\"app.tab.ready\").map(r=>r.cause_event_id).filter(Boolean)[0]")
if [ -n "$EVENT_ID" ] && [ "$CAUSE_ID" = "$EVENT_ID" ]; then
  pass "trigger log joins back to the app.tab.ready envelope (${CAUSE_ID})"
else
  fail "causal join missing: cause_event_id='${CAUSE_ID}' vs event_id='${EVENT_ID}'"
fi
kill "$TAB_PID" 2>/dev/null
# ─────────────────────────────────────────────────────────────────────────────
banner "F  ground truth"
PY_AFTER=$(have python3); GIT_AFTER=$(have git)
echo "python3=${PY_AFTER}  git=${GIT_AFTER}"
[ "$PY_AFTER" = "yes" ]  && pass "python3 installed" || fail "python3 still missing"
[ "$GIT_AFTER" = "yes" ] && pass "git installed"     || fail "git still missing"

# ─────────────────────────────────────────────────────────────────────────────
banner "G  once per machine, not once per boot"
# Without this the fire-once gate is untested: a trigger that re-fires on every
# restart would pass every assertion above. The person opens the app again.
flow stop >/dev/null 2>&1 || true
sleep 3
flow start service
for i in $(seq 1 90); do gcurl -fsS "${API}/health/status" >/dev/null 2>&1 && break; sleep 1; done
GATE=$(flow auth get-cookie-gate)
gcurl -fsS "${API}/graph/bootstrap" >/dev/null 2>&1
: > /tmp/tab2.log
TAB_PID=$(open_tab /tmp/tab2.log)
sleep 25
AFTER=$(trigger_counter)
[ "${AFTER:-0}" = "1" ] && pass "counter still 1 after a restart with the app open — fire_once holds" \
                        || fail "counter is '${AFTER:-unset}' after restart; setup fired again"
grep -q '"open_wizard_popup"' /tmp/tab2.log && fail "the setup popup came back after a restart" \
                                             || pass "no setup popup on the second launch"
kill "$TAB_PID" 2>/dev/null

# ─────────────────────────────────────────────────────────────────────────────
banner "H  the first launch is usable — one agent turn on the funded key"
ANSWER=$(timeout 300 flow process start "Reply with exactly the single word pong and nothing else." 2>&1)
RC=$?
printf '%s\n' "$ANSWER" | grep -v "INFO:" | tail -5
printf '%s' "$ANSWER" | grep -qi "pong" && [ "$RC" = "0" ] \
  && pass "an agent answered through the funded endpoint (exit ${RC})" \
  || fail "no agent answer through the funded endpoint (exit ${RC})"
# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "$FAILED" = "0" ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
[ "${KEEP_ALIVE:-0}" = "1" ] && { echo "(KEEP_ALIVE=1 — sleeping so you can exec in)"; sleep infinity; }
exit "$FAILED"
