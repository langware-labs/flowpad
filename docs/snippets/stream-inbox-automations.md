---
id: d8065434-bc8f-45a0-bf2b-d55b4e83d13a
version: 3
---
# Stream stream inbox automations — snippets

**When a message arrives · if it is about X · then a wizard runs.** An stream inbox automation is an
ordinary `Trigger` (`flow_sdk/builtin/trigger.py`) of kind TAG listening to
`stream_inbox.*.message.projected`, with two things settled:

* **`if`** is a **decision op** — the ComputeOp subkind `decision` ([decisions](decisions.md) §9),
  a Decision API question asked of the message. The trigger runs it as its *gate*, before the
  counter, so a "no" costs one call and spends nothing.
* **`then`** is a **wizard** — the sequence engine that already exists ([wizards](wizards.md)).
  `run_agent` is sugar for a one-step wizard of an `agent` op. The message reaches the wizard
  as its input and the agent step mounts it as the agent's input.

The trigger owns *when* and *policy* (scope, enabled, storm cap, `fire_once`, `confirm`, the
gate). The wizard owns *what happens*. Nothing else is new: the test panel, the Runs
screen, the bus map and the `trigger.json` form all apply unchanged.

Every python fence runs, in order, as one session in
`tests/unit/test_stream_inbox_automations_snippets.py` (the Decision API doubled, the agent on the
mock worker, `item` the seeded message); the fire-path corners — order of checks, a "no" never
spends `fire_once`, unavailable, an own message, the storm guard ahead of the gate — are
pinned by `tests/unit/automations/test_stream_inbox_gate.py`, and the file ↔ row round trip by
`tests/unit/automations/test_then_round_trip.py`.

## 1. The file

```json
{
  "name": "Refund requests → Billing helper",
  "tag":  { "on": "stream_inbox.*.message.projected", "scope": ["data_source:7a1e2a40-…"] },
  "if":   "asks for a refund or disputes a charge",
  "then": { "run_agent": { "agent": "agent-5d20c1e8-…",
                           "prompt": "Confirm which charge is in question, explain the refund path, draft the reply. Don't send it." } }
}
```

`if` as a **string** is the sentence the person typed: one yes/no question, worded by the
event's subject (the stream inbox knows its own field names), acted on at 85%. The long form
is the decision op's own `exe_data` — several questions of the three decision kinds, each with
what must hold; all must hold:

```json
"if": {
  "questions": {
    "refund":  { "type": "yes_no", "instructions": "Does `text` ask for a refund or dispute a charge?" },
    "urgency": { "type": "score",  "instructions": "How urgent is `text`?", "levels": ["routine", "today", "urgent"] }
  },
  "require": { "refund": { "yes": 0.85 }, "urgency": { "at_least": "today" } }
}
```

`then` is a wizard: `{ "ref": "<wizard name>" }`, inline `{ "steps": [...], "ops": {...} }`, or
one of the sugars — `run_agent`, `run_script` — which expand to a one-step wizard. The
expansion of the file above: one `agent` op whose `input` is `MESSAGE` (the state the fire puts
in scope, §4) and whose `launch_context` is `LAUNCH` (how the session is linked back, §6).
`scope` is the channel: one data source, several, or none for any. Messages the person or
their agents sent are never caught; that is the subject's rule, not a setting.

## 2. Make one

```python
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.trigger import Trigger

work_mail = await DataSource.get_one({"name": "Work mail"})
billing = await Agent.get_one({"name": "Billing helper"})

rule = await Trigger.on_message(
    catch="asks for a refund or disputes a charge",
    sources=[work_mail],                       # [] → any channel
    agent=billing,
    prompt="Confirm which charge is in question, explain the refund path, draft the reply. Don't send it.",
)
rule.name            # 'Asks for a refund or disputes a charge → Billing helper' — rename freely
rule.enabled         # True
rule.tag_pattern     # 'stream_inbox.*.message.projected'
rule.tag_scope       # ['data_source-…'] — the row keeps targets in colon form: ['data_source:<id>']
rule.gate            # the decision op as a dict: questions, require, input='MESSAGE', sentence
rule.then            # {'run_agent': {'agent': 'agent-<id>', 'prompt': '…'}}
```

`Trigger.on_message` is the one builder; the screen's Save, `flow automation` and a
`trigger.json` all produce the same row (`gate` and `then` are plain fields on `create`).
It arms the rule at once. A rule in a project is written to its `trigger.json` by the
editor (`automations/spec_file.py`); a row alone is fine everywhere else.
`Agent.runnable_here()` is the list the agent picker offers.

## 3. The decision op, and asking it without firing

```python
from flow_sdk.core.compute_op.decision import decide_op
from flow_sdk.schema.data_spec.compute_op_spec import DecisionOp
from flow_sdk.schema.data_spec.message_state_spec import MessageState

gate = DecisionOp.model_validate(rule.gate)
gate.sentence          # 'asks for a refund or disputes a charge'
gate.questions["match"].instructions
#   'Is this true of the message (`text`, `subject`, from `sender`): asks for a refund or disputes a charge?'
gate.require["match"].yes          # 0.85

verdict = await decide_op(gate, MessageState.from_text("Hi, I was billed for a plan I cancelled. Can you reverse it?"))
verdict.met            # True
verdict.confidence     # 0.9 — the deciding answer's probability
verdict.reason         # 'asks for a refund or disputes a charge'
verdict.answers        # {'match': {'type': 'yes_no', 'probability': 0.9}}

verdict = await rule.decide_on(text="Attached is the invoice for September.")   # the same, through the rule
```

`decide_op` answers a `DecisionVerdict` (`compute.returned.decision`), like every op answers
a `ReturnedValue`; it records nothing and runs nothing — this is the fast test under the
sentence and the try list over recent messages. A `DecisionError` is `met=False` with
`unavailable` naming the closed reason. `rule.decide_on` takes `text=`, `message_id=` or a
state.

## 4. What the decision and the agent see: `stream_inbox.message.state`

```python
from flow_sdk.automations import decision_subjects
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.stream_inbox.message_subject import state_of

fm = await FlowMessage.get_one({"source_item_id": item.id})
state = state_of(fm)
state.model_dump(mode="json", exclude_defaults=True)
# {'sender': 'Dana Levi <dana@customer.test>', 'subject': 'Charged twice for October',
#  'text': 'I see two charges of $49 …', 'received_at': '…', 'conversation_id': '…', 'message_id': '…'}

subject = decision_subjects.for_target(f"source_item:{item.id}")
subject.scope_key      # 'MESSAGE' — the name the state travels under into the wizard
subject.kind           # 'stream_inbox.message.state'
```

One value serves both halves: the `state` the questions refer to by name, and the wizard's
`MESSAGE` input the agent step mounts. `text` is the body's head (`TEXT_MAX_CHARS`; a cut is
counted in `text_cut`). The event names a `source_item`; the **decision subjects** registry
(`automations/decision_subjects.py`) maps a target type — and the tag patterns carrying it —
to its subject, so a rule on another kind of event gets its own state the same way. A subject
refuses our own and our agents' messages before any question is asked.

## 5. The fire path, and what it leaves behind

The gate sits after every cheap check and before the counter:

```
disabled → already_fired → self_loop → storm → confirm → GATE → counter → trigger.fired → run_wizard(then, inputs={MESSAGE, LAUNCH, EVENT})
```

| The gate says | Log row | `reason_code` | On the bus |
| --- | --- | --- | --- |
| caught | `tag_fire` + `tag_fire_done` | | `trigger.decided` · `trigger.fired` · `stream_inbox.<provider>.message.status {state: handling}` |
| not caught | `tag_declined` | `decision_no` | `trigger.decided` |
| could not ask | `tag_declined` | `decision_unavailable` | `trigger.decided` · `trigger.failed {stage: decision}` |

```python
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.tags import drain, emit_tag, target_of

emit_tag(f"stream_inbox.{item.provider}.message.projected", target_of("source_item", item.id),
         {"entity_id": item.id, "source_id": work_mail.id},
         ctx={"scope": [target_of("data_source", work_mail.id)]})
await drain()                        # the handlers the emit scheduled, awaited — a script's choice, never the bus's

runs = await Trigger.runs(rule.id, include_declined=True)
run = runs[0]                        # AutomationRun, newest first
run.status                           # 'succeeded' — the agent step's run, asked how it ended
run.decision                         # {'caught': True, 'confidence': 0.9, 'reason': '…', 'answers': {...}, 'endpoint': 'api_endpoint-…', 'latency_ms': …}
run.subject_id                       # the message's id — the state is rebuilt from it, never stored
run.wizard["steps"]["handle"]["executor"]   # 'agentic_process-<id>' — the agent step's session
run.agentic_process_id               # the same id, bare
process = await AgenticProcess.get_by_id(run.agentic_process_id)
```

Three keys are new on the trigger log (`fs_store/operations/trigger_log.py` copies a fixed
set): `decision`, `subject_id` and `wizard` (the `then` result, each step trimmed).
`trigger.decided` carries `{trigger_id, cause_event_id, outcome: caught|no|unavailable,
confidence, reason}` on target `trigger:<id>`; like the rest of `trigger.*` it is not
forwarded to the app. The wizard runs with the rule's trust and its project folder as
`workdir`; its step progress is the Activity the wizard viewer already shows.

## 6. What the agent gets

The agent step is an `AgentOp` with `input` (the state, mounted as the process's input folder
the way `Agent.launch(input=…)` mounts one) and `launch_context` (the `LaunchContext` the
subject builds: the session keyed to the conversation, the message as a context chip, and
what the rule decided under `context_data["automation"]`).

```python
from flow_sdk.builtin.agentic_process.process_io import input_dir

process.target_typeid_str                 # 'conversation-<id>'
[str(t) for t in process.shared_context_entities if str(t).startswith("flow_message-")]   # ['flow_message-<id>']
process.context_data["automation"]        # {'trigger_id', 'run_id', 'name', 'reason', 'confidence', 'subject_id'}
sorted(p.name for p in input_dir(process).iterdir())   # the stream_inbox.message.state value, as files
```

In the worker, the message is the input folder and the conversation is one command away:

```bash
flow conversation show <conversation-id>
flow conversation reply <conversation-id> --draft "…"
```

The chip on the message and the stream inbox row find the session by two typed fields that already
exist — `target_typeid_str` is the conversation, `shared_context_entities` holds the message —
live over the socket, because a process is an entity. Status is the process's own. The
session's first line ("Caught by … · asks for a refund · 90%") is `context_data["automation"]`.

## 7. A decision as a step

The same op inside a wizard, for a branch mid-sequence: a `decision` step binds its plain
answer, `on_fail: stop` ends the run quietly when it is not met, and `when` runs a later step
only while a value matches ([decisions](decisions.md) §9, [wizards](wizards.md) §5–6). As a
rule's `then`:

```json
"then": { "steps": [
  { "id": "route",   "ref": "which-team", "bind": "TEAM", "on_fail": "stop" },
  { "id": "billing", "ref": "billing-helper", "when": { "TEAM": "billing" } },
  { "id": "bugs",    "ref": "bug-triage",     "when": { "TEAM": "bug" } }
], "ops": {
  "which-team": { "subkind": "decision", "exe_data": { "input": "MESSAGE",
                  "questions": { "team": { "type": "choice", "instructions": "Where should `text` go?",
                                           "options": { "billing": "money", "bug": "the product is broken" } } },
                  "require": { "team": { "choice": "billing" } } } },
  "billing-helper": { "subkind": "agent", "exe_data": { "agent": "agent-…", "prompt": "Handle the refund.", "input": "MESSAGE", "launch_context": "LAUNCH" } },
  "bug-triage":     { "subkind": "agent", "exe_data": { "agent": "agent-…", "prompt": "Triage the bug.",   "input": "MESSAGE", "launch_context": "LAUNCH" } }
} }
```

The gate on the trigger stays where it is: a step runs after the fire has been counted; the
gate runs before.

## 8. The verbs the screens use

```python
tries = await rule.decide_on_recent(limit=20)   # the try list: recent messages on the rule's sources, each with its verdict;
tries[0]["decided_at"] is not None              # True — one the rule already decided for real answers from the log, no call made
summary = next(s for s in await Trigger.overview() if s.id == rule.id)   # the list, one pass over every rule's log
summary.last_runs                               # the row's execution marks — the last five real runs, newest first
summary.passed_over                             # fires the gate declined
summary.started_last_hour                       # the top-bar counter sums it over the person's own rules (not Flowpad's built-ins) — the same pass, no second walk
```

"Run on this one" is `run_once(rule, message_id=…)` (`automations/run_once.py`): the real
envelope of that message, every guard off, rows carrying `is_test`. Every verb is an action
on `Trigger` reached through `ts_sdk/src/entities/trigger.ts`, so no component builds a
request (`ui/tests/unit/triggers-view-url.test.ts`).

## 9. The same in TypeScript

```ts
import { Trigger } from '@sdk';

const rule = await Trigger.onMessage({ catch: 'asks for a refund or disputes a charge', sources: [workMail.id], agent: billing.id, prompt });
const verdict = await Trigger.decideOn(rule.id, { text: 'I was billed twice…' });   // { met, confidence, reason, answers }
const tries = await Trigger.decideOnRecent(rule.id, { limit: 20 });
const rows = await Trigger.overview();                                             // the list, one pass over every rule's log
const started = await Trigger.startedLastHour();                                   // the top-bar counter: the person's own rules, one light call
```

Pinned by `ui/tests/unit/stream-inbox-automations-snippet.test.ts`.

## What is deliberately not here

* **No new entity, no new engine.** A rule is a `Trigger`; its then is a `WizardSpec`; a run
  is a log row folded with the wizard's result; the session is an `AgenticProcess`. The
  chip rides the process because `trigger.*` is never forwarded to the app and a process
  already is.
* **The gate is not a step.** A step runs after the fire is counted, `fire_once` spent and
  `trigger.fired` emitted. The gate runs before any of that, which is what makes a "no" free.
* **No stored state.** The row keeps `subject_id`; the state is rebuilt from the message when
  anyone asks.
* **No provider names, no deterministic ids.** The subject registry keys on the target
  type; the channel is `tag_scope`; the handling status tag reuses the cause event's segment.
* **A decision is never a dependency.** Unavailable means not caught, recorded as such, and
  the rule waits; the editor says so in one banner.
