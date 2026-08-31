# A source whose fetch is a process (`provider: agent`)

> **Ground rules (inline by design):** evidence never events · read before you
> poke · never widen a wait · never destroy the user's data · credentials are
> the user's step.

Every other driver reaches its provider over HTTP with a credential. This one
spawns a harness worker and lets it use the connectors the person has **already
authorised** — which is what makes a source possible for a system we have no
first-class integration with. Gmail is read this way today; Slack, Calendar and
Drive are the same shape with a different prompt.

`modes/connect.md` still drives the gates, and `scripts/source_ctl.py` still
creates the row. Load this file for what is true here and nowhere else.

## 1. The sync result reports nothing, and that is success

```python
outcome = await sync_source(source, now=datetime.now(timezone.utc))
outcome.created            # 0 on a HEALTHY agent fetch — do not assert on it
```

The worker records each record itself through `flow record create source_item`,
which lands on the same ingest chokepoint the poller uses. Returning those items
from `fetch` as well would ingest every message **twice**, so the driver returns a
receipt instead of rows.

Count what arrived by reading it:

```python
rows = await SourceItem.get_all({"data_source_id": source.id})
```

Through the skill's own tooling that is `SC observe <id>` and `SC items <id>`,
exactly as for any other source — the gates do not change, only what you must not
believe.

## 2. Two budgets, and neither is yours to widen

`deadline_seconds` (default 300) bounds one fetch; at most two workers run
concurrently across all agent sources. `AgenticProcess` has neither — `run`/`wait`
poll forever and there is no global cap — which is why these live in the driver
and were approved explicitly.

A fetch that times out is `config` health, not `transient`. That is the honest
verdict: a stuck worker is a configuration problem to diagnose in
`modes/debug.md`, and raising the deadline to make a run pass hides it.

## 3. The harness is a pre-flight, not a hope

```python
from flow_sdk.builtin.agentic_process.launch_health import ensure_launchable

problem = await ensure_launchable("claude")   # None means it can run
```

Bounded, never raises, reads the same discovery SSOT the driver does. A missing
or logged-out harness parks the source on `config_error`, which reads like a
broken mailbox and is not one — so check it while choosing the transport, in
`references/mapping.md`, rather than discovering it on the first poll.

## Driving a process yourself

Rarely needed — the driver owns the fetch. When a task genuinely calls for it
(authoring a source that activates processes, or testing one): build the process
with `load_flowpad_assistant=True`, which is what mounts this skill tree — there
is no "load skill" call — `prompt()` it, and `exit()` in a `finally`, because a
leaked worker outlives its caller and holds its slot.

**`prompt()` returning is not the turn finishing, and `wait()` is the wrong
cure.** `wait()` blocks for a TERMINAL worker status, which a conversational
process never reaches — it finishes the turn and sits ready for the next one, so
waiting on it burns the whole budget and reports nothing. Poll for the OUTCOME
instead: the artifact the run declared.

```python
produced = await Artifact.get_all({"generated_by": str(process.typeid)})
source = await Entity.get_by_typeid(TypeId(produced[0].target_type_id))
```

`tests/long_tests/test_gmail_agent_source.py` is the worked example.
