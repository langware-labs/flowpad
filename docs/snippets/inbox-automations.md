---
id: d8065434-bc8f-45a0-bf2b-d55b4e83d13a
version: 3
---
# Inbox automations — snippets

**When a message arrives · if it is about X · then a wizard runs.** An inbox automation is an
ordinary `Trigger` (`flow_sdk/builtin/trigger.py`) of kind TAG listening to
`stream_inbox.*.message.projected`, with two things settled:

* **`if`** is a **decision op** — a new ComputeOp subkind, `compute_op.decision`, a Decision
  API question asked of the message. The trigger runs it as its *gate*, before the counter,
  so a "no" costs one call and spends nothing.

* **`then`** is a **wizard** — the sequence engine that already exists
  ([wizards](wizards.md)). `run_agent` is sugar for a one-step wizard of an `agent` op. The
  message reaches the wizard as its input and the agent step mounts it as the agent's input.

The trigger owns *when* and *policy* (scope, enabled, storm cap, `fire_once`, `confirm`, the
gate). The wizard owns *what happens*. Nothing else is new: the test panel, the Runs
screen, the bus map and the `trigger.json` form all apply unchanged.

Every python fence runs, in order, as one session in
`tests/unit/test_inbox_automations_snippets.py` (the Decision API doubled, the agent on the
mock worker); the fire-path corners — order of checks, a "no" never spends `fire_once`, the
self-loop, unavailable — are pinned by `tests/unit/automations/test_inbox_gate.py`.

## 1. The file

```json
{
  "name": "Refund requests → Billing helper",
  "tag":  { "on": "stream_inbox.*.message.projected", "scope": ["data_source:7a1e2a40-…"] },
  "if":   "asks for a refund or disputes a charge",
  "then": { "run_agent": { "agent": "billing-helper",
                           "prompt": "Confirm which charge is in question, explain the refund path, draft the reply. Don't send it." } }
}
```

`if` as a **string** is the sentence the person typed: one yes/no question, acted on at 85%.
The long form is the decision op's own `exe_data` — several questions of the three decision
kinds, each with what must hold; all must hold:

```json
"if": {
  "questions": {
    "refund":  { "type": "yes_no", "instructions": "Does `text` ask for a refund or dispute a charge?" },
    "urgency": { "type": "score",  "instructions": "How urgent is `text`?", "levels": ["routine", "today", "urgent"] }
  },
  "require": { "refund": { "yes": 0.85 }, "urgency": { "at_least": "today" } }
}
```

`then` is a wizard: `{ "ref": "<wizard name>" }`, inline `{ "steps": [...] }`, or one of the
sugars — `run_agent`, `run_script` — which expand to a one-step wizard. The expansion of the
file above:

```json
"then": { "steps": [ { "id": "handle", "kind": "compute", "ref": "billing-helper",
                       "args": { "input": "MESSAGE" } } ] }
```

`MESSAGE` is the value the fire puts in scope (§4). `scope` is the channel: one data source,
several, or none for any. Messages the person or their agents sent are never caught; that is
not a setting.

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
rule.name            # 'Refund requests → Billing helper' — made from the sentence and the agent; rename freely
rule.enabled         # True
rule.tag_pattern     # 'stream_inbox.*.message.projected'
rule.tag_scope       # ['data_source:7a1e…']
rule.gate            # DecisionOp — the `if`, as exe_data of a compute_op.decision
rule.then            # WizardSpec — one step, an agent op bound to MESSAGE
```

`Trigger.on_message` is the one builder; the screen's Save, `flow automation` and a
`trigger.json` all produce the same row (`Trigger.create(when=…, gate=…, then=…)` underneath,
which every kind uses). It writes the file when the rule lives in a project
(`automations/spec_file.py`), the row alone otherwise. `Agent.runnable_here()` is the list
the agent picker offers: agents with a local deployment that is enabled.

## 3. The decision op, and asking it without firing

```python
from flow_sdk.schema.data_spec.compute_op_spec import DecisionOp
from flow_sdk.stream_inbox.message_state import MessageState

gate = DecisionOp.from_sentence("asks for a refund or disputes a charge", subject=MessageState)
gate.questions   # {'match': YesNoQuestion(instructions='Is this true of the message (`text`, `subject`, from `sender`): asks for a refund or disputes a charge?')}
gate.require     # {'match': Require(yes=0.85)}
gate.sentence    # the string form, or None when authored long-hand

state = MessageState.from_text("Hi, I was billed for a plan I cancelled last month. Can you reverse it?")
verdict = await gate.decide(state)
verdict.caught       # True
verdict.confidence   # 0.91 — the deciding answer's probability
verdict.reason       # 'asks for a refund or disputes a charge'  (the sentence, or the first failing requirement)
verdict.answers      # {'match': YesNoAnswer(probability=0.91)}
```

`DecisionOp` is `exe_data` for the subkind `decision`; its answer is a `GateVerdict`
(kind `compute.returned.verdict`), like every op answers a `ReturnedValue`. The **subject**
renders the sentence into the question, because only the state kind knows its own field
names: `MessageState.question_for(sentence)` here, a `task.state` later wording its own.
Several questions are one round trip. A `DecisionError` is `verdict.caught is False` with
`verdict.unavailable = e.reason`.

`decide` records nothing and runs nothing: this is the fast test under the sentence and the
try-list over recent messages. `rule.decide_on(state)` is the same call through the rule.

## 4. What the decision and the agent see: `stream_inbox.message.state`

```python
from flow_sdk.builtin.flow_message import FlowMessage

fm = await FlowMessage.get_one({"source_item_id": item.id})
state = await MessageState.of(fm)
state.model_dump(exclude_none=True)
# {'channel': 'gmail', 'sender': 'Dana Levi <dana@…>', 'subject': 'Charged twice for October',
#  'text': 'I see two charges of $49 …', 'received_at': '2026-10-10T10:41:00Z',
#  'conversation_id': '…', 'message_id': '…', 'files': ['invoice.pdf']}
```

One value serves both halves: the `state` the questions refer to by name, and the wizard's
`MESSAGE` input the agent step mounts. `text` is capped at `MessageState.TEXT_MAX_CHARS`
(the head of the body; a cut is marked). The event names a `source_item`; the **decision
subjects** registry maps a target type to its state kind, so a rule on `task:*` later gets a
`task.state` the same way:

```python
from flow_sdk.automations import decision_subjects

decision_subjects.for_target("source_item:2f9c…")   # MessageState — builder, kind, question_for
```

## 5. The fire path, and what it leaves behind

The gate sits after every cheap check and before the counter:

```
disabled → already_fired → self_loop → storm → confirm → GATE → counter → trigger.fired → run_wizard(then, inputs={"MESSAGE": state})
```

| The gate says | Log row                      | `reason_code`          | On the bus                                                                                       |
| ------------- | ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| caught        | `tag_fire` + `tag_fire_done` | <br />                 | `trigger.decided` · `trigger.fired` · `stream_inbox.<provider>.message.status {state: handling}` |
| not caught    | `tag_declined`               | `decision_no`          | `trigger.decided`                                                                                |
| could not ask | `tag_declined`               | `decision_unavailable` | `trigger.decided` · `trigger.failed {stage: decision}`                                           |

```python
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.tags import event_bus

await event_bus.publish("stream_inbox.gmail.message.projected",
                        target=f"source_item:{item.id}", data={"entity_id": item.id, "source_id": work_mail.id},
                        scope=[f"data_source:{work_mail.id}"])

runs = await Trigger.runs(rule.id, include_declined=True)
run = runs[0]                        # AutomationRun, newest first
run.status                           # 'launched' | 'running' | 'succeeded' | 'failed' | 'skipped'
run.decision                         # {'caught': True, 'confidence': 0.93, 'reason': '…', 'answers': {...}, 'endpoint': 'api_endpoint-…', 'latency_ms': 312}
run.flow_message_id                  # the message — the state is rebuilt from it, never stored
run.wizard                           # WizardResult: each step's answer, ok, ran
run.agentic_process_id               # the session: the agent step's PromptResult.executor
process = await AgenticProcess.get_by_id(run.agentic_process_id)
```

Two keys are new on the trigger log (`fs_store/operations/trigger_log.py` copies a fixed set):
`decision` and `flow_message_id`; `wizard` is the run's `WizardResult` folded the way
`agentic_process_id` already is. `trigger.decided` carries `{trigger_id, cause_event_id,
outcome: caught|no|unavailable, confidence, reason}` on target `trigger:<id>`; like the rest
of `trigger.*` it is not forwarded to the app. The wizard runs with the trigger's trust and
the rule's project as `workdir`; its step progress is the Activity the wizard viewer already
shows.

## 6. What the agent gets

The agent step is an `AgentOp` with one addition, `input`: a scope value mounted as the
process's input folder, the way `Agent.launch(input=…)` already does.

```python
process.target_typeid_str            # 'conversation-<id>'  — the session is keyed to the conversation
process.shared_context_entities      # ['flow_message-<id>'] — the message, as a context chip
process.context_data["automation"]   # {'trigger_id': …, 'run_id': …, 'reason': '…', 'confidence': 0.93} — the session's first line
process.input_spec                   # the stream_inbox.message.state value, at execution/input/
```

In the worker, the message is the input folder and the conversation is one command away:

```bash
flow conversation show <conversation-id>
flow conversation reply <conversation-id> --draft "…"
```

The chip on the message and the inbox row find the session by two typed fields that already
exist — `target_typeid_str` is the conversation, `shared_context_entities` holds the message —
live over the socket, because a process is an entity. Status is the process's own.

## 7. A decision as a step (second phase)

The same op in a wizard, for a branch mid-sequence. A step that answers "not met" ends the
run quietly — `ok=True, ran=False`, a third outcome beside `on_fail`'s abort and continue —
and a later step may ask for a value in scope:

```json
"then": { "steps": [
  { "id": "route",   "kind": "compute", "ref": "which-team", "bind": "TEAM", "on_no": "stop" },
  { "id": "billing", "kind": "compute", "ref": "billing-helper", "args": { "input": "MESSAGE" }, "when": { "TEAM": "billing" } },
  { "id": "bugs",    "kind": "compute", "ref": "bug-triage",     "args": { "input": "MESSAGE" }, "when": { "TEAM": "bug" } }
] }
```

`when` is a mapping of scope values, like `args`: an equality, never a template. The gate on
the trigger stays where it is — a step runs after the fire has been counted; the gate runs
before. Pinned with the wizard page's test once it lands.

## 8. The verbs the screens use

```python
await Trigger.decide_on_recent(rule, limit=20)        # the try list: GateVerdict per recent message on the rule's sources;
                                                      # rows already decided for real come from the log, no call made
summary = (await Trigger.overview())[0]               # the list, one pass over every rule's log
summary.recent_runs                                   # the row's last five, each with its agentic_process_id
summary.started_last_hour                             # summed across rules for the top-bar counter — the same pass, no second walk
await Trigger.run_once(rule.id, message=fm)           # "Run on this one": decide + run the wizard, rows carry is_test
```

Every one is an action on `Trigger` reached through `ts_sdk/src/entities/trigger.ts`, so no
component builds a request (`ui/tests/unit/triggers-view-url.test.ts`).

## 9. The same in TypeScript

```ts
import { Trigger } from '@sdk';

const rule = await Trigger.onMessage({ catch: 'asks for a refund or disputes a charge', sources: [workMail.id], agent: billing.id, prompt });
const verdict = await Trigger.decideOn(rule.id, { text: 'I was billed twice…' });   // { caught, confidence, reason, answers }
const tries = await Trigger.decideOnRecent(rule.id, { limit: 20 });
const rows = await Trigger.overview();                                             // started_last_hour summed by the top bar
```

Pinned by `ui/tests/unit/inbox-automations-snippet.test.ts`.

## What is deliberately not here

* **No new entity, no new engine.** A rule is a `Trigger`; its then is a `WizardSpec`; a run
  is a log row folded with the wizard's result; the session is an `AgenticProcess`. The
  chip rides the process because `trigger.*` is never forwarded to the app and a process
  already is.

* **The gate is not a step.** A step runs after the fire is counted, `fire_once` spent and
  `trigger.fired` emitted. The gate runs before any of that, which is what makes a "no" free.

* **No stored state.** The row keeps `flow_message_id`; the state is rebuilt from the
  message when anyone asks.

* **No provider names, no deterministic ids.** The subject registry keys on the target
  type; the channel is `tag_scope`; the handling status tag reuses the cause event's segment.

* **A decision is never a dependency.** Unavailable means not caught, recorded as such, and
  the rule waits; the editor says so in one banner.

