#!/usr/bin/env bash
# The clean-container proof, run as PID 1.
#
#   index -> wizard -> trigger -> app ready -> event -> trigger fires -> wizard runs
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
WIZARD_UNAME="wizard_dev_toolchain_0"
WIZARD_NAME="Developer toolchain"
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
for i in $(seq 1 90); do
  curl -fsS "${API}/health/status" >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS "${API}/health/status" >/dev/null 2>&1; then pass "backend healthy on :${PORT}"
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
  curl -fsS -X POST "${API}/graph/compute_node/secrets" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"lm_api.openrouter\",\"value\":\"${OPENROUTER_API_KEY}\",\"description\":\"first-launch e2e\"}" \
    >/dev/null 2>&1

  # And read back through the backend too, for the same reason.
  SEEDED=$(curl -fsS "${API}/graph/compute_node/secrets" 2>/dev/null \
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
  for i in $(seq 1 90); do curl -fsS "${API}/health/status" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "${API}/health/status" >/dev/null 2>&1 \
    && pass "backend restarted with the key in its store" \
    || { fail "backend did not come back after seeding"; echo "RESULT: FAIL"; exit 1; }
elif [ -n "${FLOWPAD_CLOUD_USER_EMAIL:-}" ]; then
  curl -fsS -X POST "${API}/cloud/login" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
  WHO=$(curl -fsS "${API}/cloud/status" 2>/dev/null | jq_ 'd.data.user.email')
  [ -n "$WHO" ] && pass "logged in as ${WHO}" || fail "cloud login did not take"
  curl -fsS -X POST "${API}/cloud/ws/connect" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
else
  fail "FLOWPAD_CLOUD_USER_EMAIL unset — the installer agent has no LLM to spend"
fi

# ─────────────────────────────────────────────────────────────────────────────
banner "D  the app becomes ready"
# `first_bootstrap_served` is set ONLY by this route — not by health, not by the
# CLI. There is no browser in here, so the test plays the client's part.
BOOT=$(curl -fsS "${API}/graph/bootstrap" 2>/dev/null | wc -c)
[ "$BOOT" -gt 100 ] && pass "bootstrap served (${BOOT} bytes)" || fail "bootstrap did not answer"

# ─────────────────────────────────────────────────────────────────────────────
banner "E  the chain"
EVENT_ID=""; COUNTER=""; ACT_STATE=""; CAUSE_ID=""; CHIP_SAW_IT=""
DEADLINE=$(( $(date +%s) + BUDGET_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # Read the ring EARLY and cache: it holds 200 entries and the wizard's own
  # traffic can evict our envelope before the run ends.
  if [ -z "$EVENT_ID" ]; then
    EVENT_ID=$(curl -fsS "${API}/debug/recent_events" 2>/dev/null \
      | jq_ '(((d.data||d).events)||[]).filter(e=>e.tag==="app.ready").map(e=>e.id)[0]')
  fi
  if [ -z "$COUNTER" ]; then
    TRIGGERS=$(curl -fsS "${API}/graph/trigger" 2>/dev/null)
    COUNTER=$(printf '%s' "$TRIGGERS" | jq_ "(d.data||d).filter(r=>r.uname===\"${WIZARD_UNAME}\").map(r=>r.counter)[0]")
  fi
  # A trigger-fired run reports at INSTANCE scope, so it is on the unscoped
  # address and in the unscoped list — the same one the footer chip replays
  # from. Asserting the unscoped read is therefore also asserting that a user
  # would actually have seen this run.
  NODE=$(curl -fsS "${API}/activity/wizard-dev-toolchain" 2>/dev/null \
    | jq_ 'JSON.stringify({state:(d.data||d).state,done:(d.data||d).done,total:(d.data||d).total,kids:((d.data||d).children||[]).map(c=>c.name+":"+c.state)})')
  case "$NODE" in *state*) ACT_STATE="$NODE";; esac
  if [ -z "$CHIP_SAW_IT" ]; then
    curl -fsS "${API}/activity" 2>/dev/null | grep -q "dev-toolchain" && CHIP_SAW_IT=yes
  fi
  # NOT "python3 and git exist" — the binaries appear the moment the last step's
  # command lands, which is BEFORE the run stamps its record, so breaking there
  # read `run_state` while it was still empty and called a successful run
  # unrecorded. The run SETTLING is the only thing that means the run is over.
  # A settled run ends the wait, whether it completed or failed. Without this a
  # failing run burns the whole budget before reporting, which reads as a hang
  # rather than a verdict.
  WIZ=$(curl -fsS "${API}/graph/wizard" 2>/dev/null)
  SETTLED=$(printf '%s' "$WIZ" | jq_ "(d.data||d).filter(w=>w.name===\"${WIZARD_NAME}\").map(w=>(w.run_state||{}).status)[0]")
  [ -n "$SETTLED" ] && break
  sleep 5
done

[ -n "$EVENT_ID" ] && pass "app.ready emitted (event_id=${EVENT_ID})" \
                   || fail "no app.ready envelope was observed"
[ "${COUNTER:-0}" = "1" ] && pass "trigger ${WIZARD_UNAME} fired exactly once" \
                          || fail "trigger counter is '${COUNTER:-unset}', expected 1"
case "$ACT_STATE" in
  *state*) pass "the wizard reported through the activity tree: ${ACT_STATE}" ;;
  *)       fail "the wizard never reported through the activity tree" ;;
esac
# ...and the OUTCOME from the durable record. The activity monitor deliberately
# holds only LIVE work — a finished root is gone — so the loop above can only
# ever hold the last snapshot it caught, which says "running" whether the run
# then succeeded, failed, or is still going. `run_state` is written to disk when
# the run settles and rides on the entity, so it is the one honest answer.
# ONE fetch, two reads off it — the shape the script already uses for $TRIGGERS
# and $LOG. Two separate curls could also disagree if the run settled between
# them, reporting a status from before the outcomes it prints beside it.
WIZ=$(curl -fsS "${API}/graph/wizard" 2>/dev/null)
RUN_STATUS=$(printf '%s' "$WIZ" | jq_ "(d.data||d).filter(w=>w.name===\"${WIZARD_NAME}\").map(w=>(w.run_state||{}).status)[0]")
RUN_STEPS=$(printf '%s' "$WIZ" | jq_ "(d.data||d).filter(w=>w.name===\"${WIZARD_NAME}\").map(w=>((w.run_state||{}).outcomes||[]).map(o=>o.step_id+':'+o.status).join(' '))[0]")
case "$RUN_STATUS" in
  completed) pass "the wizard run completed: ${RUN_STEPS}" ;;
  "")        fail "the wizard never recorded a run at all (run_state is empty)" ;;
  *)         fail "the wizard run ended '${RUN_STATUS}': ${RUN_STEPS}" ;;
esac
# Reporting to nobody is the failure this catches: the run can be perfect at its
# own address and still never reach the footer chip.
[ "$CHIP_SAW_IT" = "yes" ] && pass "the run was visible in the unscoped list a client renders" \
                           || fail "the run never appeared in the unscoped list — a user would not have seen it"

# The causal join: the trigger log records the envelope id that caused the fire.
# This is the assertion that turns "these all happened" into "this caused that",
# and it exists only because the trigger is a row rather than a subscription.
# `/graph/trigger/fires` — the class-level action, which reads every rule's log.
# NOT `/rules/<name>/log`: that router is unmounted (404 everywhere), and the
# per-entity `log` action keys on the trigger's NAME while this test knows its
# uname, so it answers [] for the row we are asking about.
LOG=$(curl -fsS "${API}/graph/trigger/fires?limit=500" 2>/dev/null)
CAUSE_ID=$(printf '%s' "$LOG" | jq_ '(d.data||d).filter(r=>r.trigger&&r.hook_event==="tag_fire").map(r=>r.cause_event_id).filter(Boolean)[0]')
if [ -n "$EVENT_ID" ] && [ "$CAUSE_ID" = "$EVENT_ID" ]; then
  pass "trigger log joins back to the app.ready envelope (${CAUSE_ID})"
else
  fail "causal join missing: cause_event_id='${CAUSE_ID}' vs event_id='${EVENT_ID}'"
fi

# ─────────────────────────────────────────────────────────────────────────────
banner "F  ground truth"
PY_AFTER=$(have python3); GIT_AFTER=$(have git)
echo "python3=${PY_AFTER}  git=${GIT_AFTER}"
[ "$PY_AFTER" = "yes" ]  && pass "python3 installed" || fail "python3 still missing"
[ "$GIT_AFTER" = "yes" ] && pass "git installed"     || fail "git still missing"

# ─────────────────────────────────────────────────────────────────────────────
banner "G  once per machine, not once per boot"
# Without this the fire-once gate is entirely untested: a trigger that re-fires
# every restart would still pass every assertion above.
flow stop >/dev/null 2>&1 || true
sleep 3
flow start service
for i in $(seq 1 90); do curl -fsS "${API}/health/status" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "${API}/graph/bootstrap" >/dev/null 2>&1
sleep 20
AFTER=$(curl -fsS "${API}/graph/trigger" 2>/dev/null \
  | jq_ "(d.data||d).filter(r=>r.uname===\"${WIZARD_UNAME}\").map(r=>r.counter)[0]")
[ "${AFTER:-0}" = "1" ] && pass "counter still 1 after a restart — fire_once holds" \
                        || fail "counter is '${AFTER:-unset}' after restart; the wizard re-ran"

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "$FAILED" = "0" ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
[ "${KEEP_ALIVE:-0}" = "1" ] && { echo "(KEEP_ALIVE=1 — sleeping so you can exec in)"; sleep infinity; }
exit "$FAILED"
