# FlowEvents — the unified event bus (delivery worklog)

> **This document is the delivery ledger.** The language rationale and the full
> design discussion live in [topics.md](topics.md); this file tracks WHAT is
> built, phase by phase, with a dated Log entry appended as each phase lands.
> Statuses: `☐ planned · ▶ in progress · ✅ done`.

**The decision (2026-07-19):** everything in the system becomes a standard
event on ONE bus, and **`FlowEvent` is the consolidating name** for the
envelope. Triggers, run events, WS messages, and the peripheral event-ish
systems all become emitters/subscribers of it.

## The envelope — `FlowEvent` (normative)

One shape, both SDKs — Python `flow_sdk/topics/envelope.py`, TS
`ts_sdk/src/topics/EventBus.ts` — pinned by the shared contract fixture
`tests/fixtures/flow_event_contract.json`.

| Field       | Type          | Rule |
|-------------|---------------|------|
| `id`        | uuid4         | minted at emit (standard minter); **never rewritten on relay** |
| `timestamp` | ISO-8601 UTC  | stamped by the emitter; ordering hint, not a guarantee |
| `topic`     | string        | free dot-separated ontological string — the bus never interprets it |
| `target`    | `type:id`     | what the event is about (colon form; non-entity subjects allowed) |
| `data`      | object        | payload; UI-originated events never carry user-entered values |
| `ctx.actor?`| target form   | who caused it (`user:<id>`, `agentic_process:<id>`, `system`, `hub`) |
| `ctx.scope` | list of targets | containment chain, innermost-first; delivery-authorization input |
| `ctx.origin`| `app · local_server · hub · sandbox` | which tier emitted — required; trust policy per tier |

**Laws** (unchanged from topics.md): (1) the bus matches topic + optional
target/scope filters, never meaning; (2) at-least-once, unordered across
topics, handlers idempotent; (3) handler isolation — emit never awaits
consumers; (4) no durability in the bus — persistence is a subscriber's job;
(5) event ≠ proof — gating consumers confirm against the store; (6) cross-tier
forwarding is by declared subscription only, never ambient.

**Naming:** `FlowEvent` = the standard envelope. `RunEvent` = the flow
*engine's* run-local envelope (renamed from the old `FlowEvent`) — engine
wiring, never on the bus. Module homes stay `flow_sdk/topics/` /
`ts_sdk/src/topics/` (the grep-able "anything named topic is the unified
system" rule stands). Anything still named `event`/`message`/`op` outside the
engine is legacy, scheduled for phase 8/10.

---

## Phase 0 — Claim the name  ✅

Rename the run-local envelope (`flow_manager/envelope.py`) `FlowEvent` →
`RunEvent`; define the standard `FlowEvent` in `flow_sdk/topics/envelope.py`;
rename TS `TopicEvent` → `FlowEvent` (+ `TopicCtx` → `FlowEventCtx`). Pure
vocabulary — zero behavior, zero wire change.

**Acceptance:** grep gates — no `FlowEvent` under `flow_sdk/flow_manager/`,
no `TopicEvent` in ts_sdk/ui; all existing tests green.

### Log
- 2026-07-19 — shipped with phase 1 (one commit). Run-local envelope is
  `RunEvent`; standard `FlowEvent`/`FlowEventCtx` in `flow_sdk/topics/envelope.py`
  + TS rename. Both grep gates pass; flow suites green unchanged.

## Phase 1 — Bus core, both sides  ✅

Python `TopicEventBus` (`flow_sdk/topics/bus.py`) — faithful port of the TS
core: `emit` (sync fire-and-forget, lazy envelope, zero-subscriber fast path,
default `origin='local_server'`), `on(pattern, handler, target?, scope?)`,
`deliver(event)` (relay entry — no re-mint), handler isolation for sync AND
async handlers. The `topic_msg` WS frame (`api/messages.py TopicMessage`) with
backend→app forwarding for a declared allowlist
(`topics/ws_forward.py FORWARDED_TOPIC_PATTERNS`, starts `["flow.*"]`);
TS receiving bridge (`ts_sdk/src/topics/ws-bridge.ts`) feeds arriving frames
into the app bus via `EventBus.deliver` — same envelope, same id, origin
preserved. Contract tests pin matching semantics + the envelope JSON across
both languages via the shared golden fixture. Dev-only
`POST /api/v1/debug/emit_topic` proves the pipe end-to-end.

**Scope cut (deliberate):** app→backend forwarding is deferred — nothing needs
it yet (journeys write via REST); it lands with the first real app→backend
subscriber.

**Acceptance:** contract tests green in both languages; live drill — debug
emit on the backend arrives at an app-bus subscriber with the SAME event id
and `origin: "local_server"`.

### Log
- 2026-07-19 — shipped. Python bus (`topics/bus.py`) + `TopicMessage` frame +
  `ws_forward` (allowlist `["flow.*"]`) armed at startup; TS `deliver()` +
  `ws-bridge` wired via `UiTopicEmitter`. Contract fixture
  `tests/fixtures/flow_event_contract.json` parsed by BOTH suites (py 16,
  ts 17 tests). Live drill on flow-5: backend-minted id `bcff6c26…` observed
  verbatim on the app bus with `origin: local_server`. Scope cut as planned:
  app→backend forwarding deferred. Mini-analyzer regression complete.

## Phase 2 — Flow-boundary emitter  ✅

`FlowManager` dual-publishes `flow.started / flow.waiting / flow.done /
flow.failed` (target = the flow entity, run/node detail in `data`) beside the
legacy `FlowRunEventMessage`/`FlowNodeStatusMessage`; terminal run outputs emit
`flow.output` instead of existing only as files. **Acceptance:**
`useJourneyManager` subscribes to the topics and deletes its post-advance REST
`refresh()` — the standing journal-WS-watch-gap symptom closes.

**Detail (planned 2026-07-22):**

*Emissions — explicit calls at the four lifecycle boundaries (NOT inside the
WS mirror helpers; boundary semantics ≠ status mirroring), via one helper
`_emit_flow_topic(run, subtopic, data)` in `flow_manager/manager.py` that fills
`target = f"agentic_flow:{run.flow.flow_id}"` and
`ctx.scope = [f"agentic_flow_run:{run.id}", f"agentic_flow:{run.flow.flow_id}"]`
(innermost-first). `ctx.actor` stays None until phase 7 threads attribution.*

| site | topic | data |
|---|---|---|
| `_start_run` | `flow.started` | `{run_id}` |
| `_enter_guided_step` | `flow.waiting` | `{run_id, node_id, seq, status_line, present, await}` |
| guided release in `inject` (suspended branch) | `flow.step.done` | `{run_id, node_id, event}` |
| `_record_run_event(direction="output")` | `flow.output` | `{run_id, event, payload}` |
| `_finalize` | `flow.done` (complete) / `flow.failed` (tripped) | `{run_id, status, events, executions, error}` |

*Run-internal node statuses stay on the legacy `FlowNodeStatusMessage` — they
are engine mirroring, not boundaries; they migrate in phase 8 if at all.
Import the bus lazily inside the helper (manager must not import-cycle);
emission is best-effort try/except like the broadcasts. `ws_forward`'s
`flow.*` allowlist already covers every row above — zero forwarding changes.*

*Consumer — `ui/src/journey/useJourneyManager.ts`: replace the post-advance
`.then(() => refresh())` chain with ONE standing bus subscription
`EventBus.on('flow.step.done', h, {target: 'agentic_flow:' + journeyId})`
whose handler calls `refresh()` — law 5 kept honest: the event says *check
now*, the journal fetch stays the proof. Because the event reaches EVERY tab
via `topic_msg` (not just watch-holders), the journal-WS-watch gap closes for
cross-tab journey progress too — the bug the workaround note in that file
documents.*

*Tests — extend `tests/unit/test_flow_manager.py` with a bus-capture fixture
(`event_bus.on('flow.*', collect)` + clear in teardown): a run emits
started→output→done with correct target/scope ordering; a guided park emits
`flow.waiting` and its release emits `flow.step.done`; a tripped run emits
`flow.failed`. UI: extend the journey vitest (or add one) faking a
`flow.step.done` deliver → `refresh` called once; advance no longer chains
refresh.*

*Live drill — flow-5: walk one step of the getting-started journey; observe
`[topics] delivered flow.step.done …` in the console and the tray advancing
WITHOUT the REST refresh chain; second browser tab advances in sync (the gap
closure made visible).*

### Log
- 2026-07-22 — shipped as planned. `_emit_flow_topic` + five boundary sites in
  `flow_manager/manager.py`; `useJourneyManager` post-advance `.then(refresh)`
  chain replaced by ONE `flow.step.done` subscription (target-filtered to the
  journey). 3 bus-capture tests added (44/44 with the topic suites). Live
  drill: clicked step 1 of getting-started → tray advanced event-driven;
  step 2 advanced via REST from OUTSIDE the browser and the tab still updated
  (console: `[topics] delivered flow.step.done` + the next `flow.waiting`) —
  the journal-WS-watch gap is closed, cross-tab included. No deviations.

## Phase 3 — Entity emitter  ✅

One chokepoint edit in `DBEntity.save`/`notify_updated`/`delete`: emit
`entity.created/updated/deleted`, target = `to_entity`, scope gains
`from_entity` — dual-published; the legacy `data_op_msg` invalidation is
untouched. Biggest coverage per line changed; what phases 4–5 subscribe to.

**Detail (planned 2026-07-22):**

*The chokepoints are already narrow: every entity write mints a
`DataOpMessage` that flows through exactly two funnels —
`DBEntity._notify_observers` (db_entity.py:140 — CREATE/UPDATE from `save`,
line 421/429) and `DBEntity.add_entity_op_notification` (line 434 — the
DELETE paths, 445/874). One adapter hooks both.*

- *Adapter `flow_sdk/db/entity.on_topic.py`* (the naming rule's deletable
  bridge): `emit_entity_topic(msg: DataOpMessage)` maps
  `OperationType.CREATE/UPDATE/DELETE` → `entity.created/updated/deleted`,
  `target` = colon form of `msg.to_entity`, `ctx.scope = [from_entity]` when
  set. **Lean data on purpose**: `data = {"entity_type", "id"}` only — never
  the serialized row (hot path; law 5 says subscribers fetch what they need;
  no payload values leak into the recorder later). Wired with one guarded
  call in each funnel (`try/except`, never fails a save).
- *Backend-side only*: `entity.*` is deliberately NOT added to
  `FORWARDED_TOPIC_PATTERNS` — forwarding every entity write would storm the
  WS; the app keeps `data_op_msg` until a frontend consumer wants the topic
  form (phase 8). The bus's zero-subscriber fast path makes the emission
  ~free until phase 4 subscribes.
- *Cycle note (documented on the adapter)*: a subscriber that writes entities
  re-triggers `entity.updated` — subscribers must be idempotent and never
  unconditionally write their own trigger entity; the real storm guard is
  phase 4's trigger machinery.
- *Tests (`tests/unit/test_entity_topics.py`)*: save → `entity.created` with
  colon target; second save/update → `entity.updated`; delete →
  `entity.deleted`; `save(owner)` → scope carries the owner typeid; data is
  lean (no row fields). Regression: existing data_op WS behavior untouched.
- *Acceptance*: a backend bus subscription observes `entity.created` for a
  `UsageReport.save()` — the exact scenario phase 4's TOPIC trigger will
  subscribe to.

### Log
- 2026-07-22 — shipped, one deviation FOR the better: both planned funnels
  converge (every DataOpMessage site calls `add_entity_op_notification`), so
  the adapter hooks ONE funnel, zero double-emission. Adapter =
  `flow_sdk/db/entity_on_topic.py`; `save()` now stamps `from_entity = owner`
  on the notification so scope rides. Acceptance test green
  (UsageReport lifecycle → created/updated/deleted, lean data, owner scope);
  fs_store regression 599/599.

## Phase 4 — Triggers become subscriptions  ☐

`TriggerType.TOPIC {pattern, target?, scope?}` on the Trigger entity, firing
the existing action machinery + `on_trigger_fired` flow entry. Rides with a
confirm-against-store hook (law 5, generalized from journey `confirm`) and an
emit-storm guard. fsop/schedule/hook keep working; conceptually they demote to
emitters (`fs.*`, `time.*`, `hook.*`) behind the same subscription front.

### Log

## Phase 5 — Flows subscribe directly  ☐

Graph-level `subscriptions:` block (or a pattern trigger-node variant): the
flow declares `{pattern, target?, scope?}`; entry passes through `inject`
(inheriting run budgets as the loop guard) with event-id dedup so at-least-once
can't double-start a run. Removes the one-Trigger-entity-per-source indirection.

### Log

## Phase 6 — Remaining emitters  ☐

Worker status tick → `agent.status` (target = the AgenticProcess); hub bridge
`_dispatch_event` re-emits with `origin: hub` + preserved `actor`; compute-node
liveness → `node.*`; UI completes tag + `openDock` chokepoint coverage. Each an
adapter file per the naming rule (`<family>.on_topic.py`).

### Log

## Phase 7 — Journals speak FlowEvent  ☐

RunJournal event rows embed the full standard envelope (id, actor, scope);
trigger-log + JourneyJournal likewise; `example.json.source` aligns with `ctx`
(gains actor + event id) — training-data provenance and the event system share
one vocabulary.

### Log

## Phase 8 — Strangle the WS dialect  ☐  ⚠ the only wire-changing phase

Migrate the 31 `api/messages.py` classes one at a time: dual-publish the topic
twin → move that class's frontend consumers from `cm.on('on_<type>_msg')` to
bus subscriptions → delete the class. Finishes with deleting the journey await
machinery. The class count is the burn-down metric; no big-bang cutover.

### Log

## Phase 9 — Recorder + policy hardening  ☐

`EventBus.on("*", sink)` recorder interface; the four jsonl sinks (RunJournal,
trigger-log, transcript, I/O records) re-homed as instances of that subscriber
shape. `ctx.scope` delivery-authorization (role-walk-scope at delivery) — the
precondition for hub-origin events entering flows.

### Log

## Phase 10 — Vocabulary cleanup  ☐

Resolve the `toplog` collision (it uses "topics" for logging filters); enforce
the naming rule — anything still named `event`/`message`/`op` outside engine
internals is renamed or scheduled. End state: one word, one bus, emitters and
subscribers all the way down.

### Log

<!-- flowpad:capsule identity
version: 1
data:
  id: 668e2408-1e99-4fd8-91dd-414aab27cc11
flowpad:endcapsule identity -->
