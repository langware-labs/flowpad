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
Automations screen — what it does for them, why Flowpad needs it, and what it
touches — never implementation detail (that lives in a code comment beside the
spec). `tests/unit/automations/test_builtin_descriptions.py` holds every one to
that. Design notes that used to sit in those descriptions:

- **LLM setup** (`wizard/llm-setup/…/on-tab-ready`) is `fire_once`: it never runs
  on its own again; Settings → General → Run setup again runs the same two steps.
- **Install the VC++ runtime** (`wizard/install-vcredist/…/on-runtime-missing`) is
  deliberately NOT `fire_once`: search announces `rag.runtime.missing` at most once
  until a person acts (adds a folder, "index now"), so a "Not now" is not asked
  every tick, and a person who declined and later asks for search is asked again.
