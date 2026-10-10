---
id: d8065434-bc8f-45a0-bf2b-d55b4e83d13a
version: 2
---
# Inbox automations — snippets

**When a message arrives · if it is about X · then an agent handles it.** An inbox automation
is an ordinary `Trigger` (`flow_sdk/builtin/trigger.py`) of kind TAG, listening to
`stream_inbox.*.message.projected`, with one new block: **`if`**, a Decision API question
asked of the message before anything runs. The "then" is the existing `run_agent` action,
now handed the message. Nothing else is new: the storm guard, `fire_once`, the test panel,
the Runs screen, the bus map and the `trigger.json` file form all apply unchanged.

Every python fence runs, in order, as one session in
`tests/unit/test_inbox_automations_snippets.py` (the Decision API doubled, the agent on the
mock worker); the fire-path corners — order of checks, a "no" never spends `fire_once`, the
self-loop, unavailable — are pinned by `tests/unit/automations/test_inbox_gate.py`.

## 1. The file

```json
{
  "name": "Refund requests → Billing helper",
  "tag": { "on": "stream_inbox.*.message.projected", "scope": ["data_source:7a1e2a40-…"] },
  "if": "asks for a refund or disputes a charge",
  "actions": [ { "run_agent": { "agent": "billing-helper",
                                "prompt": "Confirm which charge is in question, explain the refund path, draft the reply. Don't send it." } } ]
}
```

`if` as a **string** is the sentence the person typed: one yes/no question, acted on at 85%.
The long form is the full `IfSpec` — several questions of the three decision kinds, each with
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

`scope` is the channel: one data source, several, or none for any. Messages the person or
their agents sent are never caught; that is not a setting.

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
rule.decide          # the IfSpec, as a dict on the row
```

`Trigger.on_message` is the one builder; the screen's Save, `flow automation` and a
`trigger.json` all produce the same row. It writes the file when the rule lives in a project
(`automations/spec_file.py`), the row alone otherwise. `Agent.runnable_here()` is the list
the agent picker offers: agents with a local deployment that is enabled.

## 3. The gate: `IfSpec`, and asking it without firing

```python
from flow_sdk.schema.data_spec.automation_if import IfSpec

gate = IfSpec.from_sentence("asks for a refund or disputes a charge")
gate.questions   # {'match': YesNoQuestion(instructions='Is this true of the message (`text`, `subject`, from `sender`): asks for a refund or disputes a charge?')}
gate.require     # {'match': Require(yes=0.85)}
gate.sentence    # the string form, or None when authored long-hand

verdict = await rule.decide_on(text="Hi, I was billed for a plan I cancelled last month. Can you reverse it?")
verdict.caught       # True
verdict.confidence   # 0.91 — the deciding answer's probability
verdict.reason       # 'asks for a refund or disputes a charge'  (the sentence, or the first failing requirement)
verdict.answers      # {'match': YesNoAnswer(probability=0.91)}
```

`decide_on` takes a `FlowMessage`, a `SourceItem`, or a bare `text=`; it builds the state
(§4), asks the Decision API once, and returns a `GateVerdict` (kind `automation.verdict`).
Nothing is recorded and nothing runs: this is the fast test under the sentence and the
try-list over recent messages. Several questions are one round trip. A `DecisionError`
surfaces as `verdict.caught is False` with `verdict.unavailable = e.reason`.

## 4. What the decision sees: `stream_inbox.message.state`

```python
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.stream_inbox.message_state import MessageState

fm = await FlowMessage.get_one({"source_item_id": item.id})
state = await MessageState.of(fm)
state.model_dump(exclude_none=True)
# {'channel': 'gmail', 'sender': 'Dana Levi <dana@…>', 'subject': 'Charged twice for October',
#  'text': 'I see two charges of $49 …', 'received_at': '2026-10-10T10:41:00Z',
#  'conversation_id': '…', 'message_id': '…', 'files': ['invoice.pdf']}
```

One value serves both halves: it is the `state` the questions refer to by name, and the
`input` the agent is launched with (§6). `text` is capped at `MessageState.TEXT_MAX_CHARS`
(the head of the body; a cut is marked). A rule's event names a `source_item`; the
**decision subjects** registry maps a target type to its state builder, so a rule on
`task:*` later gets a `task.state` the same way:

```python
from flow_sdk.automations import decision_subjects

decision_subjects.for_target("source_item:2f9c…")   # (MessageState.of, 'stream_inbox.message.state')
```

## 5. The fire path, and what it leaves behind

The gate sits after every cheap check and before the counter, so a "no" costs one decision
and nothing else:

```
disabled → already_fired → self_loop → storm → confirm → IF → counter → trigger.fired → run
```

| The gate says | Log row                      | `reason_code`          | On the bus                                                                                       |
| ------------- | ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| caught        | `tag_fire` + `tag_fire_done` | <br />                 | `trigger.decided` · `trigger.fired` · `stream_inbox.<provider>.message.status {state: handling}` |
| not caught    | `tag_declined`               | `decision_no`          | `trigger.decided`                                                                                |
| could not ask | `tag_declined`               | `decision_unavailable` | `trigger.decided` · `trigger.failed {stage: decision}`                                           |

```python
from flow_sdk.tags import event_bus

await event_bus.publish("stream_inbox.gmail.message.projected",
                        target=f"source_item:{item.id}", data={"entity_id": item.id, "source_id": work_mail.id},
                        scope=[f"data_source:{work_mail.id}"])

runs = await Trigger.runs(rule.id, include_declined=True)
run = runs[0]                        # AutomationRun, newest first
run.status                           # 'launched' | 'running' | 'succeeded' | 'failed' | 'skipped'
run.decision                         # {'caught': True, 'confidence': 0.93, 'reason': '…', 'answers': {...}, 'endpoint': 'api_endpoint-…', 'latency_ms': 312}
run.flow_message_id                  # the message — the state is rebuilt from it, never stored
run.agentic_process_id               # the session, once launched
```

Two keys are new on the trigger log (`fs_store/operations/trigger_log.py` copies a fixed set):
`decision` and `flow_message_id`. `trigger.decided` carries `{trigger_id, cause_event_id,
outcome: caught|no|unavailable, confidence, reason}` on target `trigger:<id>`; like the rest
of `trigger.*` it is not forwarded to the app.

## 6. What the agent gets

```python
process = await run.process()        # AgenticProcess
process.target_typeid_str            # 'conversation-<id>'  — the session is keyed to the conversation
process.shared_context_entities      # ['flow_message-<id>'] — the chip
process.context_data["automation"]   # {'trigger_id': …, 'run_id': …, 'flow_message_id': …, 'reason': '…', 'confidence': 0.93}
process.input_spec                   # the stream_inbox.message.state value, mounted at execution/input/
```

The launch is the existing `RUN_AGENT` handler with the envelope passed through
(`run_trigger_actions(trigger, changes, event=…)`): `agent.launch(prompt, input=state,
target_typeid_str=…, shared_context_entities=[…], context_data={"automation": …})`. In the
worker, the message is the input folder and the conversation is one command away:

```bash
flow conversation show <conversation-id>
flow conversation reply <conversation-id> --draft "…"
```

The session's first line ("Caught by … · asks for a refund · 93%") is
`context_data["automation"]` rendered; the chip on the message and the inbox row find the
session by `target_typeid_str` and group by `context_data.automation.flow_message_id`, live
over the socket, because a process is an entity. Status is the process's own.

## 7. The verbs the screens use

```python
await Trigger.decide_on_recent(rule, limit=20)        # the try list: GateVerdict per recent message on the rule's sources;
                                                      # rows already decided for real come from the log, no call made
await Trigger.started_since(hours=1)                  # the top-bar counter: fires of every kind, any trigger
(await Trigger.overview())[0].recent_runs             # the list row's last five, each with its agentic_process_id
await Trigger.run_once(rule.id, message=fm)           # "Run on this one": decide + launch, rows carry is_test
```

Every one is an action on `Trigger` reached through `ts_sdk/src/entities/trigger.ts`, so no
component builds a request (`ui/tests/unit/triggers-view-url.test.ts`).

## 8. The same in TypeScript

```ts
import { Trigger } from '@sdk';

const rule = await Trigger.onMessage({ catch: 'asks for a refund or disputes a charge', sources: [workMail.id], agent: billing.id, prompt });
const verdict = await Trigger.decideOn(rule.id, { text: 'I was billed twice…' });   // { caught, confidence, reason, answers }
const tries = await Trigger.decideOnRecent(rule.id, { limit: 20 });
const started = await Trigger.startedSince({ hours: 1 });
```

Pinned by `ui/tests/unit/inbox-automations-snippet.test.ts`.

## What is deliberately not here

* **No new entity.** A rule is a `Trigger`; a run is a log row; the session is an
  `AgenticProcess`. The chip rides the process, not the run, because `trigger.*` is never
  forwarded to the app and a process already is.

* **No stored state.** The row keeps `flow_message_id`; the state is rebuilt from the
  message when anyone asks.

* **No deterministic ids, no provider names.** The subject registry keys on the target
  type; the channel is `tag_scope`.

* **A decision is never a dependency.** Unavailable means not caught, recorded as such, and
  the rule waits; the editor says so in one banner.

