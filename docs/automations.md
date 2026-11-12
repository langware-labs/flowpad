---
id: 2a3cd19f-cd79-41b2-9d07-43a890e77b2a
version: 2
---
# Automations

"When something happens, Flowpad does something for you." An **automation** is
what a person sees; the entity underneath is a `Trigger` row (`flow_sdk/builtin/trigger.py`).
The screen was the Events dock until 2026-10-05.

## Three places, one dock

| URL                                                       | Place          | For                                                                                                                              |
| --------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/dock/automations`                                       | My automations | Everyone. One sentence per automation, its last result and next run, grouped by whose it is; Flowpad's own folded into one line. |
| `/dock/automations?trigger=<id>` (`&tab=runs`)            | One automation | Build it as **When · Then**, with **Test** beside it (Check, recent real events, Run once now) and its Runs one tab away.        |
| `/dock/automations?creating=<kind>[&recipe=<id>]`         | A new one      | Same page, empty or from a starter.                                                                                              |
| `/dock/automations/runs` (`?status=failed&trigger=&run=`) | Runs           | Every fire: why it ran, what it did, what broke; "Run again with this event".                                                    |
| `/dock/automations/bus` (`?tag=&target=`)                 | Event bus      | Experts. Every event type, how often it happened, who listens, what they do; live stream; pattern sandbox; send a test event.    |

Simple first: a SAVED automation opens as three lines — When · Where · Then, each the backend's own
sentence (`useAutomationWords`), each unfolding to its form (`Block` with a `summary`); a new one opens
unfolded. Presets, a picker, a prompt. A schedule's time zone is not an "Advanced" field: a chip by
the time shows only when the zone is not this computer's, and one searchable list sets it — under
the calendar for "Once" (`blocks/TimeZonePicker.tsx`). The rest of Advanced is one click inside an
event or file block (the pattern) and at the bottom of the page (run once ever, storm guard, the
fields as JSON, an agent rule's code). The grammar is
`ui/src/components/automations/automations-pointer.ts`; `events`, `triggers`,
`cron` (→ the list) and `signals` (→ the bus) are retired ids
(`ts_sdk/src/utils/ui/retired-views.ts`, `flow_sdk/core/dock_address.py`).

## The chain

UI → `ui/src/hooks/automations/useAutomations.ts` → TS SDK `Trigger.*` methods
(`ts_sdk/src/entities/trigger.ts`, shapes in `automation-types.ts`) → actions on
`Trigger` → `flow_sdk/automations/*`. No component or hook in the screen builds
a request itself (`ui/tests/unit/triggers-view-url.test.ts` fails if one does).

| Action                                 | Library                                                         | Answers                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `overview`                             | `automations/overview.py`                                       | `automation.summary[]` — sentence parts, group, last run, failures in the last five, next run, `tested` |
| `next_runs`                            | `automations/schedule.py`                                       | the next N times + the schedule's preset reading                                                        |
| `{id}/check`, `check_spec`             | `automations/check.py`                                          | `automation.check` — findings in words, no side effects                                                 |
| `{id}/test`                            | `automations/run_once.py`                                       | `automation.run_once` — *Run once now*                                                                  |
| `{id}/samples`, `recent_events`        | `automations/samples.py`                                        | recent real events to test with                                                                         |
| `runs`, `run`                          | `automations/runs.py`                                           | `automation.run` — history rows read as runs                                                            |
| `bus_map`, `match_pattern`             | `automations/bus_map.py`, `tags/bus.explain_subscription_match` | the bus map; the sandbox                                                                                |
| `create`, `{id}/update`, `{id}/delete` | `automations/spec_file.py` for file-defined rows                | —                                                                                                       |

## Execution is a wizard

The backend compiles the existing automation declaration into a `WizardSpec`
(`automations/compiler.py`) and calls the ordinary wizard runner
(`automations/execution.py`). It does not create a Wizard entity or rewrite the
automation's file. The automation screens, SDK methods and trigger fields keep
their existing forms.

The trigger handles delivery: subscription or schedule, enabled state, execution
location, cycle prevention and storm protection. The compiled wizard calls
ComputeOps for confirmation, subject preparation, the decision, acceptance,
GraphWorkflow activation and the work. Legacy `actions` and schedule `instruction`
are calls in that same sequence; legacy actions still continue after an action
fails, and launch-only actions still return admission rather than waiting for
their child to finish. A `then` keeps its awaited wizard behavior.

Acceptance stays after confirmation and decision, before effects: a declined
event spends no counter or `fire_once`; an accepted event spends them before
running its work, even if that work fails. The TAG invocation keeps its existing
per-trigger lock across those steps. Test runs omit confirmation and accounting,
while still evaluating the message decision. Decision previews run the decision
sequence without acceptance, effects or automation history; cached preview
answers remain cached. Check validates the same compiled definition without importing
executable blocks. The automation run ID is the wizard invocation ID.

Overlapping Wizard invocations are recorded as skipped and do not accept a
second fire. Execution exceptions produce terminal failed history with the
completed-step outline. Public history keeps outlines and invocation IDs,
not private prepared payloads or a new per-operation receipt store.

## The gate and the work (stream inbox automations)

An automation may carry an **`if`** and a **`then`** (`docs/snippets/stream-inbox-automations.md`):

- **`if`** is a `compute_op.decision` op (`Trigger.gate` on the row): questions for the Decision
  API and what each answer must be. A string in the file is the sentence a person typed, worded
  into one yes/no question by the event's **subject** (`automations/decision_subjects.py` — the
  stream inbox answers for `source_item` targets with a `stream_inbox.message.state`). The gate
  runs as a step in the compiled wizard after every cheap check and **before acceptance**: a "no" writes a
  `tag_declined` row (`reason_code` `decision_no` / `decision_unavailable`) and spends nothing —
  no counter, no `fire_once`, no `trigger.fired`. Every ask emits `trigger.decided`.
- **`then`** is a wizard (`trigger.then`: a `ref`, inline `steps` + `ops`, or the `run_agent` /
  `run_script` sugar) composed by `automations/then.py` and called from the compiled wizard with the
  fire's scope: the subject's state under its key (`MESSAGE`), the `LaunchContext` the agent step
  stamps (the session keyed to the conversation, the message as a chip, what the rule decided
  under `context_data["automation"]`), the envelope under `EVENT`. The state is in scope only
  when a gate caught one: a `then` with no gate runs its agent with no input. A rule with a
  `then` runs that instead of `actions`. A `run_script` (in `then` or in the legacy `actions`) may
  be PROJECT-RELATIVE (`agentic-assets/trigger/<name>/run.sh`): it resolves under the rule's
  project folder, so a rule checked into a project runs the same on every clone; an absolute path
  still works but belongs to one checkout. A rule on `dataset.rows.changed` names its rows by KIND,
  or it fires for every dataset write on the machine: `"tag": {"on": "dataset.rows.changed", "scope": ["kind:--acme--.crm.task"]}` — the event's scope carries the row kind, which is the same on every
  clone. (`"target": "dataset:<id>"` — the row's `tag_target` — also works, but a dataset's id is one
  machine's, so it cannot be checked in.)
- **A script that fails is a failed run.** In `then` a failing step is the run's `error`; in the legacy
  `actions` an answer that did not reach its goal (a non-zero exit, a script stopped at its budget, a
  script that is not on disk) is too — `errors` on the row and `trigger.failed` on the bus. A place
  switched off or a slot that is busy stays quiet: refusing is not failing. `then.run_script` is the
  form to write (a shell one-liner run from the project folder, as a wizard step); `actions` stay for
  files written before it and for a file rule that needs the changed paths. A job longer than a step's
  budget starts its work and returns — no budget is configurable, on purpose.
- **`runs_on`** **belongs to the rule, whatever its kind**: `"runs_on": "<deployment id>"` at the top of
  `trigger.json` (a schedule file may still carry it inside `schedule`). Only the machine that place
  runs on arms the rule — an event rule or a file rule checked into a shared project then fires once,
  not once per clone. Empty: every machine that indexes it.
- **A process of your own fires a rule through the relay.** A project's server or a
  `run_script` posts `user_app.<anything>` to `POST /api/v1/tags/relay`, and a rule on
  `"tag": {"on": "user_app.<family>.*"}` catches it (`docs/tags.md`, "Another process's events").
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

`Trigger.invoke` uses the same wizard execution path for callable hooks. The
removed `ActivationRule` engine is not restored: testing that unsupported legacy
rule-folder form returns the existing configuration-refusal response (422).

## On, off and recommended

**On/off belongs to the machine, never to the file.** A rule's switch is its row's `enabled` (with
`decided`), both PRIVATE and guarded like a projection: only `set_trigger_on` (`builtin/trigger.py`)
writes them, the row alone, so no re-index, `git pull` or edit to `trigger.json` can move a person's choice.
`trigger.json` says only `recommended` (default `true`; a legacy `enabled` key is read as it).

| The rule                                                                  | Starts                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| made here (the rules API, a schedule added here, a seed)                  | on                                                                                                                                                                        |
| indexed from a file — it came with a project                              | off, undecided: it does not run                                                                                                                                           |
| Flowpad's own (`is_builtin`)                                              | as its seed or file says — except one its file ships off (`recommended: false`, e.g. the Daily usage summary): off, and its switch is the person's (`Trigger.switchable`) |
| on a machine the hub runs only for a deployed agent (`RuntimeKind.AGENT`) | on when recommended — the deploy was its owner's choice                                                                                                                   |

A recommended undecided rule is a row of the project's setup (`automation` requirement, `project_setup. _automations_here`): the setup window lists it under "Recommended automations" with **Enable / Disable**
(`POST project/<id>/setup-automation {typeid, on}`), and the "Setup required" button counts it. The
Automations screen's switch writes the same machine-local value.

## A callback into a session

A session can set a one-time rule that calls back into ITSELF: `flow process schedule "<prompt>" --at <ISO time> | --in 2h` (`schedules` lists the waiting ones, `unschedule <id>` removes one). It is an
ordinary `date` schedule made through `POST /graph/trigger` with one `prompt_process` action
(`ActionType.PROMPT_PROCESS`: `target_type_id` is the session, `prompt` what it is asked). Row-only — a
session id is one machine's, so no `trigger.json` can say it.

- **Linked both ways.** `Trigger.link_process` cross-links the rule and the session with the generic
  `cross_link_entities`; the session's toolbar shows the rule as a chip, and `pending_callbacks(process)`
  reads the waiting ones back through that link. The screen says it as "run process <name> with prompt"
  (`ThenPart` kind `run_process`): the name is the session's chip, "prompt" opens the text. At most `MAX_PENDING_CALLBACKS` wait per session.
- **The fire** (`PromptProcessActionHandler` → `AgenticProcess.deliver_when_idle`): the session's closed
  tab comes back (unselected), the prompt goes on its prompt queue — injected at the next idle edge —
  and a stopped terminal session is started, taking the queue head as its launch prompt. No wait loop.
  The session reads one line: `This is trigger <id> callback: <prompt> (… check it is still relevant …)`.
- **Or on a repeat, with an end.** `flow process schedule "<prompt>" --every 10m --times N | --for 8h | --until <ISO>`
  makes ONE `interval` rule. It counts its runs and ends by itself; the callback line says "run 3 of 4, every
  10m — it repeats by itself; do not schedule it again". A repeat without an end is refused.
- **Runs, end and status — every kind** (`automations/lifecycle.py`). `max_runs` (`fire_once` = 1, a `date`
  one-shot = 1) and `expires_at` bound a rule's life; `lifecycle.end(rule, reason)` is the one way it ends
  (`ended_at`, `ended_reason` max\_runs | expired | cancelled): disarmed, unlinked from the session's chip,
  `trigger.ended` emitted, a reply wait's "cancelled" message posted. `enabled` stays the person's switch.
  `status` (active · off · done · expired · cancelled), `max_runs`, `runs_left`, `until` ride on every
  `AutomationSummary`; `POST trigger/<id>/cancel` (`flow process unschedule`) ends one now.
- **Or when a message is answered.** `flow conversation send|new … --on-reply "<prompt>" [--wait 2h]` makes the
  same callback woken by the reply instead of a clock (`builtin/reply_callbacks.py`): a TAG rule on
  `entity.child_created` for the conversation (every write path emits it), `awaits_reply` = the message,
  `fire_once`, `expires_at` (default 3 days). The first later message written by a person — not a session, not
  an agent; quoted or not — fires it, and the session reads the callback line plus the reply. Arming checks the
  conversation once, so a reply that landed while nothing listened still fires. Unanswered at `expires_at`: a
  "Prompt handling cancelled" message in the rule's Automations conversation, and it never fires.
- **Gone with the session.** Deleting a session deletes its waiting callbacks (`drop_callbacks`); a
  fired one stays, as every spent one-shot does.

## Rules that are easy to break

- **A one-shot whose time passed still runs, once.** The scheduler drops a run more than 60s late and a
  `date` schedule has no next one, so a rule whose time fell while the app was closed or the machine
  asleep would never run. `Trigger._register_schedule_job` runs an overdue, never-fired one-shot when it
  is armed (boot, re-index, turning it on), and the scheduler's missed-run listener re-arms it. `_FIRING`
  keeps a re-arm during the fire from starting it twice.

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

- **A file-defined automation saves to its** **`trigger.json`** and is re-indexed;
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

- **First-time setup** (`wizard/llm-setup/…/on-tab-ready`) is `fire_once`: it never runs
  on its own again; Settings → General → Run setup again runs the same two steps.
- **Search setup on Windows** (`wizard/install-vcredist/…/on-runtime-missing`) is
  deliberately NOT `fire_once`: search announces `rag.runtime.missing` at most once
  until a person acts (adds a folder, "index now"), so a "Not now" is not asked
  every tick, and a person who declined and later asks for search is asked again.

