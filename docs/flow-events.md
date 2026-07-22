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

## Phase 2 — Flow-boundary emitter  ☐

`FlowManager` dual-publishes `flow.started / flow.waiting / flow.done /
flow.failed` (target = the flow entity, run/node detail in `data`) beside the
legacy `FlowRunEventMessage`/`FlowNodeStatusMessage`; terminal run outputs emit
`flow.output` instead of existing only as files. **Acceptance:**
`useJourneyManager` subscribes to the topics and deletes its post-advance REST
`refresh()` — the standing journal-WS-watch-gap symptom closes.

### Log

## Phase 3 — Entity emitter  ☐

One chokepoint edit in `DBEntity.save`/`notify_updated`/`delete`: emit
`entity.created/updated/deleted`, target = `to_entity`, scope gains
`from_entity` — dual-published; the legacy `data_op_msg` invalidation is
untouched. Biggest coverage per line changed; what phases 4–5 subscribe to.

### Log

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
