---
id: 2a3cd19f-cd79-41b2-9d07-43a890e77b2a
---
# Automations

"When something happens, Flowpad does something for you." An **automation** is
what a person sees; the entity underneath is a `Trigger` row (`flow_sdk/builtin/trigger.py`).
The screen was the Events dock until 2026-10-05.

## Three places, one dock

| URL | Place | For |
|---|---|---|
| `/dock/automations` | My automations | Everyone. One sentence per automation, its last result and next run, grouped by whose it is; Flowpad's own folded into one line. |
| `/dock/automations?trigger=<id>` (`&tab=runs`) | One automation | Build it as **When · Then**, with **Test** beside it (Check, recent real events, Run once now) and its Runs one tab away. |
| `/dock/automations?creating=<kind>[&recipe=<id>]` | A new one | Same page, empty or from a starter. |
| `/dock/automations/runs` (`?status=failed&trigger=&run=`) | Runs | Every fire: why it ran, what it did, what broke; "Run again with this event". |
| `/dock/automations/bus` (`?tag=&target=`) | Event bus | Experts. Every event type, how often it happened, who listens, what they do; live stream; pattern sandbox; send a test event. |

Simple first: presets, a picker, a prompt. Advanced is one click inside each
block (cron, time zone, event pattern) and at the bottom of the page (run once
ever, storm guard, the fields as JSON, an agent rule's code). The grammar is
`ui/src/components/automations/automations-pointer.ts`; `events`, `triggers`,
`cron` (→ the list) and `signals` (→ the bus) are retired ids
(`ts_sdk/src/utils/ui/retired-views.ts`, `flow_sdk/core/dock_address.py`).

## The chain

UI → `ui/src/hooks/automations/useAutomations.ts` → TS SDK `Trigger.*` methods
(`ts_sdk/src/entities/trigger.ts`, shapes in `automation-types.ts`) → actions on
`Trigger` → `flow_sdk/automations/*`. No component or hook in the screen builds
a request itself (`ui/tests/unit/triggers-view-url.test.ts` fails if one does).

| Action | Library | Answers |
|---|---|---|
| `overview` | `automations/overview.py` | `automation.summary[]` — sentence parts, group, last run, failures in the last five, next run, `tested` |
| `next_runs` | `automations/schedule.py` | the next N times + the schedule's preset reading |
| `{id}/check`, `check_spec` | `automations/check.py` | `automation.check` — findings in words, no side effects |
| `{id}/test` | `automations/run_once.py` | `automation.run_once` — *Run once now* |
| `{id}/samples`, `recent_events` | `automations/samples.py` | recent real events to test with |
| `runs`, `run` | `automations/runs.py` | `automation.run` — history rows read as runs |
| `bus_map`, `match_pattern` | `automations/bus_map.py`, `tags/bus.explain_subscription_match` | the bus map; the sandbox |
| `create`, `{id}/update`, `{id}/delete` | `automations/spec_file.py` for file-defined rows | — |

## The gate and the wizard (stream inbox automations)

An automation may carry an **`if`** and a **`then`** (`docs/snippets/stream-inbox-automations.md`):

- **`if`** is a `compute_op.decision` op (`Trigger.gate` on the row): questions for the Decision
  API and what each answer must be. A string in the file is the sentence a person typed, worded
  into one yes/no question by the event's **subject** (`automations/decision_subjects.py` — the
  stream inbox answers for `source_item` targets with a `stream_inbox.message.state`). The gate
  runs in the TAG fire path after every cheap check and **before the counter**: a "no" writes a
  `tag_declined` row (`reason_code` `decision_no` / `decision_unavailable`) and spends nothing —
  no counter, no `fire_once`, no `trigger.fired`. Every ask emits `trigger.decided`.
- **`then`** is a wizard (`trigger.then`: a `ref`, inline `steps` + `ops`, or the `run_agent` /
  `run_script` sugar) run by `automations/then.py` through the ordinary wizard runner with the
  fire's scope: the subject's state under its key (`MESSAGE`), the `LaunchContext` the agent step
  stamps (the session keyed to the conversation, the message as a chip, what the rule decided
  under `context_data["automation"]`), the envelope under `EVENT`. The state is in scope only
  when a gate caught one: a `then` with no gate runs its agent with no input. A rule with a
  `then` runs that instead of `actions`. A `run_script` (in `then` or in the legacy `actions`) may
  be PROJECT-RELATIVE (`agentic-assets/trigger/<name>/run.sh`): it resolves under the rule's
  project folder, so a rule checked into a project runs the same on every clone; an absolute path
  still works but belongs to one checkout. A rule on `dataset.rows.changed` names its rows by KIND,
  or it fires for every dataset write on the machine: `"tag": {"on": "dataset.rows.changed", "scope":
  ["kind:--acme--.crm.task"]}` — the event's scope carries the row kind, which is the same on every
  clone. (`"target": "dataset:<id>"` — the row's `tag_target` — also works, but a dataset's id is one
  machine's, so it cannot be checked in.)
- **A script that fails is a failed run.** In `then` a failing step is the run's `error`; in the legacy
  `actions` an answer that did not reach its goal (a non-zero exit, a script stopped at its budget, a
  script that is not on disk) is too — `errors` on the row and `trigger.failed` on the bus. A place
  switched off or a slot that is busy stays quiet: refusing is not failing. `then.run_script` is the
  form to write (a shell one-liner run from the project folder, as a wizard step); `actions` stay for
  files written before it and for a file rule that needs the changed paths. A job longer than a step's
  budget starts its work and returns — no budget is configurable, on purpose.
- **`runs_on` belongs to the rule, whatever its kind**: `"runs_on": "<deployment id>"` at the top of
  `trigger.json` (a schedule file may still carry it inside `schedule`). Only the machine that place
  runs on arms the rule — an event rule or a file rule checked into a shared project then fires once,
  not once per clone. Empty: every machine that indexes it.
- **The run a test started is one call away.** `run_once` answers `run_id` (`RunOnceStarted`);
  `Trigger.run(run_id)` — `GET trigger/run?id=`, TypeScript `Trigger.run(started.run_id)` — answers
  `status: "running"` while it works and its history row after. No status file, no polling of `runs`.
- Log rows gain `decision`, `subject_id` and `wizard` (an outline — each step's exit code, short
  detail and session, never its output); `AutomationRun` mirrors them;
  `AutomationSummary` gains `last_runs` and `passed_over`; the top bar's last-hour count is its own
  light call (`Trigger.started_last_hour`: the person's own rules, counted on the log tails). The verbs:
  `Trigger.on_message`, `rule.decide_on`, `rule.decide_on_recent`, `Trigger.runs(include_declined=)`,
  `run_once(message_id=)`, `Agent.runnable_here()`; the screen's "Would it catch this?" asks
  `decide_spec` with the fields as typed, before any save. A bare `gate: {sentence}` (the screen's,
  a file's string `if`) is worded by the row itself on construction (`Trigger._word_gate`), so every
  writer gates alike, and every reader takes the op from `Trigger.gate_op`. A subject also says how
  its rules read (`when_text`: "When a message arrives") on the list and in `describe_when`, and
  answers the lookups by id (`by_id`, `test_event`) so the automation code never names a message.
  Check reports a missing Decision API under its own area, `decider`: the rule is fine, the machine
  is not ready.

## Rules that are easy to break

- **Run once now** runs even when the automation is off and spends nothing a real
  fire spends: no counter bump (a once-only rule stays unspent), no storm budget,
  no confirm query. Its rows carry `is_test`.
- **"Not tested yet"** compares `spec_hash` (`automations/fingerprint.py`, the
  hash of what the rule DOES) against test rows and successful real runs.
  `updated_date` cannot answer it: every fire and every boot re-index moves it.
- **The history stays JSONL** (`fs_store/operations/trigger_log.py`, keyed by rule
  name). Readers always filter by `trigger_id` (names repeat). Keys added for
  runs: `error`, `duration_ms`, `cause_data` (capped at 300 characters — never a
  payload), `spec_hash`. An event fire writes a start row before the work and a
  `tag_fire_done` row after it, joined on `event_id`.
- **A file-defined automation saves to its `trigger.json`** and is re-indexed;
  a row-only write would be reverted by the next index.
- **Flowpad's own** (`Trigger.is_builtin`) refuse edits and deletes.
- **Another install's copy** of a shipped trigger is never armed
  (`trigger_arming.trigger_runs_here`); a boot sweep removes rows whose asset is
  gone (`builtin_triggers.reap_stale_trigger_rows`).
- **Crontab weekdays**: `_parse_trigger` spells the day-of-week field out by name
  — APScheduler 3.x counts Monday as 0, so `1-5` used to fire Tuesday to Saturday.

## Flowpad's own automations

Each built-in carries a `description` written for the person reading the
Automations screen — one or two calm sentences on what they get from it, saying
it stays on their computer where that is true; never implementation detail (that
lives in a code comment beside the spec) and never words that sound like
watching them. `tests/unit/automations/test_builtin_descriptions.py` holds every one to
that. Design notes that used to sit in those descriptions:

- **First-time setup** (`wizard/llm-setup/…/on-tab-ready`) is `fire_once`: it only logs when a tab is watching (the
  UI opens the first-run flow on every app load until the wizard has run fully once) and runs the wizard itself
  when nobody is; Settings → General → Run setup again runs the same two steps.
- **Search setup on Windows** (`wizard/install-vcredist/…/on-runtime-missing`) is
  deliberately NOT `fire_once`: search announces `rag.runtime.missing` at most once
  until a person acts (adds a folder, "index now"), so a "Not now" is not asked
  every tick, and a person who declined and later asks for search is asked again.
