# FlowEvents — the unified event bus (delivery worklog)

> **This document is the delivery ledger.** The language rationale and the full
> design discussion live in [tags.md](tags.md); this file tracks WHAT is
> built, phase by phase, with a dated Log entry appended as each phase lands.
> Statuses: `☐ planned · ▶ in progress · ✅ done`.

**The decision (2026-07-19):** everything in the system becomes a standard
event on ONE bus, and **`FlowEvent` is the consolidating name** for the
envelope. Triggers, run events, WS messages, and the peripheral event-ish
systems all become emitters/subscribers of it.

## The envelope — `FlowEvent` (normative)

One shape, both SDKs — Python `flow_sdk/tags/envelope.py`, TS
`ts_sdk/src/tags/EventBus.ts` — pinned by the shared contract fixture
`tests/fixtures/flow_event_contract.json`.

| Field       | Type          | Rule |
|-------------|---------------|------|
| `id`        | uuid4         | minted at emit (standard minter); **never rewritten on relay** |
| `timestamp` | ISO-8601 UTC  | stamped by the emitter; ordering hint, not a guarantee |
| `tag`     | string        | free dot-separated ontological string — the bus never interprets it |
| `target`    | `type:id`     | what the event is about (colon form; non-entity subjects allowed) |
| `data`      | object        | payload; UI-originated events never carry user-entered values |
| `ctx.actor?`| target form   | who caused it (`user:<id>`, `agentic_process:<id>`, `system`, `hub`) |
| `ctx.scope` | list of targets | containment chain, innermost-first; delivery-authorization input |
| `ctx.origin`| `app · local_server · hub · sandbox` | which tier emitted — required; trust policy per tier |

**Laws** (unchanged from tags.md): (1) the bus matches tag + optional
target/scope filters, never meaning; (2) at-least-once, unordered across
tags, handlers idempotent; (3) handler isolation — emit never awaits
consumers; (4) no durability in the bus — persistence is a subscriber's job;
(5) event ≠ proof — gating consumers confirm against the store; (6) cross-tier
forwarding is by declared subscription only, never ambient.

**Naming:** `FlowEvent` = the standard envelope. `RunEvent` = the flow
*engine's* run-local envelope (renamed from the old `FlowEvent`) — engine
wiring, never on the bus. Module homes stay `flow_sdk/tags/` /
`ts_sdk/src/tags/` (the grep-able "anything named tag is the unified
system" rule stands). Anything still named `event`/`message`/`op` outside the
engine is legacy, scheduled for phase 8/10.

---

## Phase 0 — Claim the name  ✅

Rename the run-local envelope (`graph_workflow_manager/envelope.py`) `FlowEvent` →
`RunEvent`; define the standard `FlowEvent` in `flow_sdk/tags/envelope.py`;
rename TS `TagEvent` → `FlowEvent` (+ `TagCtx` → `FlowEventCtx`). Pure
vocabulary — zero behavior, zero wire change.

**Acceptance:** grep gates — no `FlowEvent` under `flow_sdk/graph_workflow_manager/`,
no `TagEvent` in ts_sdk/ui; all existing tests green.

### Log
- 2026-07-19 — shipped with phase 1 (one commit). Run-local envelope is
  `RunEvent`; standard `FlowEvent`/`FlowEventCtx` in `flow_sdk/tags/envelope.py`
  + TS rename. Both grep gates pass; flow suites green unchanged.

## Phase 1 — Bus core, both sides  ✅

Python `TagEventBus` (`flow_sdk/tags/bus.py`) — faithful port of the TS
core: `emit` (sync fire-and-forget, lazy envelope, zero-subscriber fast path
behind a bounded observation poke, default `origin='local_server'`), `on(pattern, handler, target?, scope?)`,
`deliver(event)` (relay entry — no re-mint), handler isolation for sync AND
async handlers. The `tag_msg` WS frame (`api/messages.py TagMessage`) with
backend→app forwarding for a declared allowlist
(`tags/ws_forward.py FORWARDED_TAG_PATTERNS`, starts `["graph_workflow.*"]`);
TS receiving bridge (`ts_sdk/src/tags/ws-bridge.ts`) feeds arriving frames
into the app bus via `EventBus.deliver` — same envelope, same id, origin
preserved. Contract tests pin matching semantics + the envelope JSON across
both languages via the shared golden fixture. Dev-only
`POST /api/v1/debug/emit_tag` proves the pipe end-to-end.

**Scope cut (deliberate):** app→backend forwarding is deferred — nothing needs
it yet (journeys write via REST); it lands with the first real app→backend
subscriber.

**Acceptance:** contract tests green in both languages; live drill — debug
emit on the backend arrives at an app-bus subscriber with the SAME event id
and `origin: "local_server"`.

### Log
- 2026-07-19 — shipped. Python bus (`tags/bus.py`) + `TagMessage` frame +
  `ws_forward` (allowlist `["graph_workflow.*"]`) armed at startup; TS `deliver()` +
  `ws-bridge` wired via `UiTagEmitter`. Contract fixture
  `tests/fixtures/flow_event_contract.json` parsed by BOTH suites (py 16,
  ts 17 tests). Live drill on flow-5: backend-minted id `bcff6c26…` observed
  verbatim on the app bus with `origin: local_server`. Scope cut as planned:
  app→backend forwarding deferred. Mini-analyzer regression complete.

## Phase 2 — Flow-boundary emitter  ✅

`GraphWorkflowManager` dual-publishes `graph_workflow.started / graph_workflow.waiting /
graph_workflow.done / graph_workflow.failed` (target = the flow entity, run/node detail in `data`) beside the
legacy `GraphWorkflowRunEventMessage`/`GraphWorkflowNodeStatusMessage`; terminal run outputs emit
`graph_workflow.output` instead of existing only as files. **Acceptance:**
`useJourneyManager` subscribes to the tags and deletes its post-advance REST
`refresh()` — the standing journal-WS-watch-gap symptom closes.

**Detail (planned 2026-07-22):**

*Emissions — explicit calls at the four lifecycle boundaries (NOT inside the
WS mirror helpers; boundary semantics ≠ status mirroring), via one helper
`_emit_flow_tag(run, subtag, data)` in `graph_workflow_manager/manager.py` that fills
`target = f"graph_workflow:{run.flow.flow_id}"` and
`ctx.scope = [f"graph_workflow_run:{run.id}", f"graph_workflow:{run.flow.flow_id}"]`
(innermost-first). `ctx.actor` stays None until phase 7 threads attribution.*

| site | tag | data |
|---|---|---|
| `_start_run` | `graph_workflow.started` | `{run_id}` |
| `_enter_guided_step` | `graph_workflow.waiting` | `{run_id, node_id, seq, status_line, present, await}` |
| guided release in `inject` (suspended branch) | `graph_workflow.step.done` | `{run_id, node_id, event}` |
| `_record_run_event(direction="output")` | `graph_workflow.output` | `{run_id, event, payload}` |
| `_finalize` | `graph_workflow.done` (complete) / `graph_workflow.failed` (tripped) | `{run_id, status, events, executions, error}` |

*Run-internal node statuses stay on the legacy `GraphWorkflowNodeStatusMessage` — they
are engine mirroring, not boundaries; they migrate in phase 8 if at all.
Import the bus lazily inside the helper (manager must not import-cycle);
emission is best-effort try/except like the broadcasts. `ws_forward`'s
`graph_workflow.*` allowlist already covers every row above — zero forwarding changes.*

*Consumer — `ui/src/journey/useJourneyManager.ts`: replace the post-advance
`.then(() => refresh())` chain with ONE standing bus subscription
`EventBus.on('graph_workflow.step.done', h, {target: 'graph_workflow:' + journeyId})`
whose handler calls `refresh()` — law 5 kept honest: the event says *check
now*, the journal fetch stays the proof. Because the event reaches EVERY tab
via `tag_msg` (not just watch-holders), the journal-WS-watch gap closes for
cross-tab journey progress too — the bug the workaround note in that file
documents.*

*Tests — extend `tests/unit/test_graph_workflow_manager.py` with a bus-capture fixture
(`event_bus.on('graph_workflow.*', collect)` + clear in teardown): a run emits
started→output→done with correct target/scope ordering; a guided park emits
`graph_workflow.waiting` and its release emits `graph_workflow.step.done`; a tripped run emits
`graph_workflow.failed`. UI: extend the journey vitest (or add one) faking a
`graph_workflow.step.done` deliver → `refresh` called once; advance no longer chains
refresh.*

*Live drill — flow-5: walk one step of the getting-started journey; observe
`[tags] delivered graph_workflow.step.done …` in the console and the tray advancing
WITHOUT the REST refresh chain; second browser tab advances in sync (the gap
closure made visible).*

### Log
- 2026-07-22 — shipped as planned. `_emit_flow_tag` + five boundary sites in
  `graph_workflow_manager/manager.py`; `useJourneyManager` post-advance `.then(refresh)`
  chain replaced by ONE `graph_workflow.step.done` subscription (target-filtered to the
  journey). 3 bus-capture tests added (44/44 with the tag suites). Live
  drill: clicked step 1 of getting-started → tray advanced event-driven;
  step 2 advanced via REST from OUTSIDE the browser and the tab still updated
  (console: `[tags] delivered graph_workflow.step.done` + the next `graph_workflow.waiting`) —
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

- *Adapter `flow_sdk/db/entity.on_tag.py`* (the naming rule's deletable
  bridge): `emit_entity_tag(msg: DataOpMessage)` maps
  `OperationType.CREATE/UPDATE/DELETE` → `entity.created/updated/deleted`,
  `target` = colon form of `msg.to_entity`, `ctx.scope = [from_entity]` when
  set. **Lean data on purpose**: `data = {"entity_type", "id"}` only — never
  the serialized row (hot path; law 5 says subscribers fetch what they need;
  no payload values leak into the recorder later). Wired with one guarded
  call in each funnel (`try/except`, never fails a save).
- *Backend-side only*: `entity.*` is deliberately NOT added to
  `FORWARDED_TAG_PATTERNS` — forwarding every entity write would storm the
  WS; the app keeps `data_op_msg` until a frontend consumer wants the tag
  form (phase 8). The bus's zero-subscriber fast path keeps the emission
  ~free until phase 4 subscribes — it costs one dict poke, because `emit`
  records every tag name in a bounded observed map (cap 512, drop-oldest)
  before the fast path returns. Seeing names nobody subscribes to yet is the
  point: it feeds `/api/v1/debug/observed_tags` and the blessed-vs-anonymous
  diff in the tags gardening view. Timestamps are stored as epoch floats and
  only formatted on that read.
- *Cycle note (documented on the adapter)*: a subscriber that writes entities
  re-triggers `entity.updated` — subscribers must be idempotent and never
  unconditionally write their own trigger entity; the real storm guard is
  phase 4's trigger machinery.
- *Tests (`tests/unit/test_entity_tags.py`)*: save → `entity.created` with
  colon target; second save/update → `entity.updated`; delete →
  `entity.deleted`; `save(owner)` → scope carries the owner typeid; data is
  lean (no row fields). Regression: existing data_op WS behavior untouched.
- *Acceptance*: a backend bus subscription observes `entity.created` for a
  `UsageReport.save()` — the exact scenario phase 4's TAG trigger will
  subscribe to.

### Log
- 2026-07-22 — shipped, one deviation FOR the better: both planned funnels
  converge (every DataOpMessage site calls `add_entity_op_notification`), so
  the adapter hooks ONE funnel, zero double-emission. Adapter =
  `flow_sdk/db/entity_on_tag.py`; `save()` now stamps `from_entity = owner`
  on the notification so scope rides. Acceptance test green
  (UsageReport lifecycle → created/updated/deleted, lean data, owner scope);
  fs_store regression 599/599.

## Phase 4 — Triggers become subscriptions  ✅

`TriggerType.TAG {pattern, target?, scope?}` on the Trigger entity, firing
the existing action machinery + `on_trigger_fired` flow entry. Rides with a
confirm-against-store hook (law 5, generalized from journey `confirm`) and an
emit-storm guard. fsop/schedule/hook keep working; conceptually they demote to
emitters (`fs.*`, `time.*`, `hook.*`) behind the same subscription front.

**Detail (planned 2026-07-22):**

*Entity + registration (`flow_sdk/builtin/trigger.py`):*
- `TriggerType.TAG = "tag"` + three fields: `tag_pattern: str`,
  `tag_target: str|None`, `tag_scope: list[str]` (names prefixed to avoid
  colliding with the entity's own scope field). Validation on save: pattern
  non-empty, no bare `"*"` for enabled triggers (a firehose trigger is always
  a mistake — pointed error).
- Registration follows the schedule/fsop precedent: `_register_tag_subscription()`
  called from the same post-save seam (`_register_post_save` in
  `server/builtin_triggers.py` + trigger.py:499's create path) — subscribes
  `event_bus.on(pattern, handler, target=..., scope=...)`; unsubscribers held
  in a module registry keyed by trigger id so disable/delete/re-register
  replaces cleanly (the APScheduler `replace_existing` idiom). Boot: a
  startup sweep arms every enabled TAG trigger (same place fsop arms
  watchers).

*Fire path — reuse `_fire_schedule_job`'s shape, not a new pipeline:*
- New `_fire_tag_trigger(trigger_id, event: FlowEvent)`: counter/last_run
  update → **confirm hook** → flow activation (`on_trigger_fired`) → action
  dispatch via `get_action_handler` with `changes=[]` and the ENVELOPE riding
  a new optional `event=` kwarg (handlers that don't know it ignore it) →
  trigger-log entry embedding the envelope (phase-7 preview).
- **Confirm-against-store (law 5)**: optional `confirm: {type, filter}` on the
  trigger — when set, run the entity query and fire only on a match (the
  journey `confirm` generalized). Default: no confirm (the event's identity
  data is usually enough).
- **Storm guard (the bus has no budgets)**: per-trigger token bucket —
  `max_fires_per_minute` (default 30) tracked in-memory on the subscription;
  exceeding it drops fires and writes ONE `storm_suppressed` trigger-log
  entry per window (never silent). Also the structural cycle brake: a TAG
  trigger's own action emissions carry `ctx` untouched — a trigger whose
  actions re-emit its own pattern hits the bucket, not infinity.

*Flow entry:* nothing new — `on_trigger_fired(trigger_id)` already enters
every flow whose trigger node references the Trigger entity; a TAG trigger
is just a new fire source for the same id.

*Tests (`tests/unit/test_tag_triggers.py`):* register → emit matching tag
→ actions dispatch + counter bumps; target/scope filters gate; disable →
no fire; re-register replaces (no double-fire); storm guard trips at the cap
and logs once; confirm-gated trigger fires only when the store query matches;
`entity.created` on UsageReport fires a TAG trigger end-to-end (the phase-3
acceptance scenario completed).

*Live drill (flow-5):* create a TAG trigger `{pattern: "entity.created",
target: "usage_report:*"}` wired to a flow's trigger node; run the
daily-analysis backfill; the new flow starts from the report's creation event
— a flow triggered by another flow's output, with zero hand wiring.

*Deferred within phase 4:* fsop/schedule/hook demotion to emitters stays
conceptual (they keep working as-is); their `fs.*`/`time.*`/`hook.*` emission
adapters land in phase 6 with the other emitters.

### Log
- 2026-07-22 — shipped. `builtin/tag_triggers.py` (registry + fire path +
  storm guard + confirm), TriggerType.TAG + 5 fields, full create/update/
  delete lifecycle + boot sweep. Deviations: (a) fires for one trigger are
  SERIALIZED (per-trigger asyncio.Lock) — concurrent fires lost counter
  updates; (b) handlers do NOT yet receive the envelope kwarg (fixed
  signature) — it rides the trigger-log entry instead, until a handler needs
  it. **Bonus find:** the live drill exposed a latent GraphWorkflowManager race — a
  fresh run could be finalize-swept during `_start_run`'s awaits, before its
  entry event routed (journal showed run_end BEFORE the entry event). Fixed
  at the invariant: runs are BORN RESERVED (`_Run.pending = 1`, released by
  the entry path) + a regression test simulating the sweep at the worst
  window. Live drill green: daily-analysis report `entity.created` → TAG
  trigger → palette-drill run, complete with correct journal ordering — a
  flow chained off another flow's output, zero hand wiring. 53/53 + suites.

## Phase 5 — Flows subscribe directly  ✅

Graph-level `subscriptions:` block (or a pattern trigger-node variant): the
flow declares `{pattern, target?, scope?}`; entry passes through `inject`
(inheriting run budgets as the loop guard) with event-id dedup so at-least-once
can't double-start a run. Removes the one-Trigger-entity-per-source indirection.

**Detail (planned 2026-07-22):**

*Document (`graph_workflow_doc.py`)*: `GraphWorkflowDoc.subscriptions: list[GraphWorkflowSubscriptionDef]`
— `{id, pattern, target?, scope?, event?, node?}`. On a matching FlowEvent the
flow gets a FRESH run whose entry event is `event` (default: the bus tag
string), `data = {tag, target, data}` (the envelope's payload nested — a
function reads the full context), delivered to `node` directly when set, else
edge-routed from `$external`. `validate_graph`: non-empty/non-`*` pattern
(same pointed message as TAG triggers — reuse `validate_tag_trigger`),
`node` must exist.

*Manager*: per-flow arming — `_arm_subscriptions(loaded)` diffs on doc load
(`_flow_subs: dict[flow_id, list[unsub]]`; disabled flow → disarmed). Two
arming paths: a BOOT SWEEP (`arm_all_flow_subscriptions()`, called beside
`start_tag_triggers`) because flows load lazily, and a bus-dogfooding
re-arm — the manager itself subscribes `entity.updated` target
`graph_workflow:*` and reloads/re-arms that flow (graph edits arm without a
restart).

*Safety*:
- **Event-id dedup at entry**: bounded per-manager LRU of seen envelope ids
  (cap 1024) — at-least-once delivery can't double-start a run.
- **Self-loop brake**: an event whose `ctx.scope` contains this flow's own
  target (`graph_workflow:<id>` — every `graph_workflow.*` boundary emission carries it)
  never enters the same flow — a flow subscribing to its own boundary events
  would otherwise spawn runs forever. Cross-flow chaining stays legal.
- Run budgets (hops/processes/deadline) apply as-is; a per-subscription rate
  cap is DEFERRED (TAG triggers already offer capped subscription→flow).

*Tests*: subscription entry (pattern+target → run with mapped event/data);
direct-`node` delivery; dedup (same envelope delivered twice → one run);
self-loop brake (graph_workflow.done of workflow A never re-enters A; B chaining off A
works); re-arm on doc change; validation.

*Live drill (flow-5)*: palette-drill drops its Trigger-entity indirection —
graph gains `subscriptions: [{pattern: "entity.created", target:
"usage_report:*"}]`; daily backfill → palette-drill run starts from the
subscription; second identical deliver attempt deduped.

*UI*: none this phase (subscriptions are graph.json-authored; inspector
support later).

### Log
- 2026-07-22 — shipped, one addition BEYOND plan: the chaining test built a
  mutual A↔B ping-pong (fresh envelopes per hop defeat both id-dedup and the
  self-brake), so the deferred rate cap landed NOW —
  `config.max_entries_per_minute` (default 30) per flow, one warning per
  window, with a ping-pong regression test. Everything else as planned:
  GraphWorkflowSubscriptionDef (+ validation reusing validate_tag_trigger), arming
  on doc load + boot sweep + entity.updated re-arm (bus dogfooding),
  envelope-id LRU dedup, self-loop brake via ctx.scope. Live drill:
  palette-drill dropped its Trigger indirection for
  `subscriptions: [{pattern: entity.created, target: usage_report:*}]` —
  backfill report creation started the run with the mapped {tag, target,
  data} entry. 34/34 flow suite.

## Phase 6 — Remaining emitters  ✅

Worker status tick → `agent.status` (target = the AgenticProcess); hub bridge
`_dispatch_event` re-emits with `origin: hub` + preserved `actor`; compute-node
liveness → `node.*`; UI completes tag + `openDock` chokepoint coverage. Each an
adapter file per the naming rule (`<family>_on_tag.py`).

**Detail (planned 2026-07-22):**
- `agent.status` — emitted from the change-gated seam in
  `_emit_status_report` (agentic_process.py): lean data
  `{worker_status, process_status, busy}`, target `agentic_process:<id>`;
  the full report keeps riding its legacy watcher-scoped channel.
- Hub relay — `hub_bridge._dispatch_event` re-emits as **`hub.entity.<op>`**
  (NOT `entity.*`): until phase-9 scope authorization, hub-origin events stay
  in their own family so no TAG trigger / flow subscription treats them as
  local writes by accident; `origin: "hub"`, target = colon form. Documented
  deviation from the original table.
- `node.connected/disconnected/…` — emitted from `auth_state.
  set_connection_status` (the ONE funnel every hub-connection transition
  already flows through), target = the local ComputeNode; the wider
  three-mechanism liveness unification stays future work.
- UI coverage — already at need (clicks / route-loaded / sandbox signals via
  `UiTagEmitter`); broader `data-tag` tagging is CONTENT work, deferred.

### Log
- 2026-07-22 — shipped as planned: agent.status (change-gated seam, lean
  data), hub.entity.<op> relay (own family + origin:hub + actor when
  carried), node.<transition> from the set_connection_status funnel
  (target = get_local ComputeNode). Live drill was three phases dogfooding:
  a TAG trigger `{pattern: agent.status}` fired 4× during a palette-drill
  agent turn — worker ticks → bus → phase-4 trigger, end to end. 2 unit
  tests (node transitions, hub relay); agent.status covered by the drill.

## Phase 7 — Journals speak FlowEvent  ✅

RunJournal event rows embed the full standard envelope (id, actor, scope);
trigger-log + JourneyJournal likewise; `example.json.source` aligns with `ctx`
(gains actor + event id) — training-data provenance and the event system share
one vocabulary.

**Detail (planned 2026-07-22):** the honest slice is PROVENANCE ALIGNMENT —
run-internal RunEvents are engine wiring, not bus envelopes, so they don't
grow scope/origin; they gain the two identity fields that make records
traceable:
- `RunEvent.id` (minted) + `RunEvent.actor` — and when a run is ENTERED from
  a bus envelope (subscription entry / tag-trigger fire), the envelope's
  `id` and `ctx.actor` are PRESERVED onto the entry RunEvent (never
  re-minted — the relay law at the flow door). `inject` gains
  `envelope: FlowEvent | None`.
- Journal `event` rows carry `event_id` (+ `actor` when present); run
  input/output records inherit both via model_dump.
- `_Run.actor` = the entry event's actor; `example.json.source` gains
  `actor` + `event_id` — training examples finally answer "who caused this"
  and link to the exact envelope.
- Trigger-log already embeds the envelope (phase 4). JourneyJournal advance
  is REST-driven (no envelope at that door) — unchanged, noted.

### Log
- 2026-07-22 — shipped as planned: RunEvent.id (minted) + .actor; inject
  gains `envelope=` and PRESERVES the bus envelope's id/actor at the flow
  door (relay law); journal event rows carry event_id (+ actor); _Run.actor
  stamps example.json.source with actor + event_id. Test: subscription entry
  from an actor-carrying envelope → journal row AND execution example both
  hold the verbatim envelope id + user:u-42. Live drill on flow-5 confirms
  entry rows carry event_id. 66 tests green across the suites.

## Phase 8 — Strangle the WS dialect  ▶ UNPARKED (2026-07-31)  ⚠ the only wire-changing phase

> Unparked to make the flow canvas bus-driven, which is the precondition for a
> single consolidated event surface. **Tiers A and B are DONE**; Tier C is
> mechanical and outstanding; **Tier D remains parked** and still rides with
> phase 9 — nothing in this pass needs it. The standing rule is unchanged: NEW
> push-style events go on the bus (a tag + allowlist entry), never as a new
> WSMessageType.

Migrate the legacy WS dialect one class at a time: dual-publish the tag
twin → move that class's frontend consumers from `cm.on('on_<type>_msg')` to
bus subscriptions → delete the class. No big-bang cutover.

**Detail (analyzed 2026-07-22 — full two-sided rescan):** the "31 classes"
framing was wrong. Reality: 38 `WSMessageType` members / 21 frontend-dispatched
types, of which only ~14 are EVENT-shaped. Phase 8 strangles the EVENT
dialect; streams and RPC stay off the bus BY DESIGN (they are not events).

*Tier A — free wins (delete, no migration):* `transcript_msg`→`on_stream_msg`
(zero subscribers), the `on_bin_msg` ArrayBuffer path (zero subscribers),
`entity_msg` (explicit no-op), plus the backend classes with no constructor
anywhere (Echo, Compute*, CommandStatus, ClientReady, PtyOutputMessage as a
CLASS — audit each, then delete).

*Tier B — the flow pair (flagship migration):* `flow_run_event_msg` +
`flow_node_status_msg`. Consumers today are DISJOINT from the bus (GraphWorkflows
store + proc-watch ride the legacy pair; only journeys ride tags). Needs:
emit `graph_workflow.node.status` + full run-event twins (REVISES the phase-2 position —
"run-internal stays off the bus" was about routing, but the WS mirror already
ships every node status to the app, so tag form adds no traffic), move
`graph-workflows/store.ts` + `proc-watch.ts` to `useOnTag`/EventBus, delete
the two classes AND the agenticFlows EventEmitter re-emit layer (the last
journey-era machinery).

*Tier C — singleton status pushes (the burn-down bulk, ~9 classes, each ONE
emitter + ONE consumer):* `toplog_state`→`system.toplog`, `privacy_mode`→
`system.privacy`, `cloud_login_status`→`auth.login`, `cloud_connection_status`
(node.* twin already exists from phase 6 — consumer moves, class dies),
`auth_expired`→`auth.expired`, `hub_client_error`→`hub.error`, `llm_config`→
`auth.oauth`, `recovered_msg`→`agent.recovered`, `broadcast('tabs_changed')`→
`entity`-driven or `tabs.changed`. Mechanical recipe per class: twin emit →
allowlist pattern → move consumer → delete TS interface + CM case + backend
class + enum member.

*Tier D — the two whales, SPLIT OUT as phase 8b:* `data_op_msg` (THE entity
invalidation channel, 6+ consumers incl. the FlowSync store) and
`flow_data_msg` (watcher-scoped per-entity streams). Blocker: both are
WATCHER-SCOPED per client today; the bus forward is pattern-level to ALL
clients — strangling them requires **per-connection tag subscriptions**
(client declares patterns/targets over the WS; backend forwards matching
frames to that client only — law 6 applied per-connection). That machinery
overlaps phase 9's scope-authorization and should land WITH it. Until then,
`entity.*` stays off the allowlist exactly as phase 3 decided.

*Keep off the bus permanently:* `rest_api_msg`/`response_msg` (RPC pair),
`pty_output_msg` (high-frequency ordered stream with seq replay),
`control_msg`/`oauth_msg`/`ui_command` (session control), ping/pong/hangup
(protocol). Transport lifecycle (`on_open`/`on_reconnected`…) is
ConnectionManager's own domain — not messages.

*Order:* A (deletes) → C one class at a time (lowest risk, fastest burn-down)
→ B (flagship, needs the flows-UI validation drills) → 8b deferred to ride
with phase 9. Burn-down metric: EVENT-dialect classes remaining (start ~14;
after 8a target: 2 — the whales).

### Log

**2026-07-31 — Tier A ✅.** Deleted 8 zero-constructor classes and their enum
members from BOTH `api/messages.py` and the stale `api/api_types/messages.py`
(29→21 and 20→12): Echo, Hangup, Stream, Transcript, ComputeExe, ComputeCtrl,
CommandStatus, ClientReady, plus the orphaned `ExeMessageSubType` /
`CtlMessageSubType`. **Correction to the plan's Tier A list: `EntityMessage` and
`ComputeMessage` are NOT deletable** — they are the base classes of
`DataOpMessage` (the entity invalidation channel) and `ResponseMessage` (the
WS-REST RPC). Only their wire semantics are dead. TS left alone: its
`ControlMessage` is `{state: boolean}`, a different shape from the backend's
`{subtype, content}`, and `FlowSync/store.ts` subscribes to it — dead on arrival,
but not free to remove.

**2026-07-31 — Tier B ✅.** `graph_workflow.run.event` + `graph_workflow.node.status`
replace `flow_run_event_msg` / `flow_node_status_msg`. Both classes, both enum
members, the TS interfaces, the two dispatch cases, the two CM handlers and the
`GraphWorkflowsClient` EventEmitter/`bootstrap()` re-emit layer are gone; the two
payload shapes are now plain types on the service.

Implementation note: the twins are emitted **inside `_broadcast_run_event` /
`_broadcast_node_status`**, not at the 12 call sites — every site already
funnelled through those two helpers, so nothing can be missed. They reuse
`_emit_flow_tag`, inheriting `target` and `ctx.scope` (which is what keeps the
subscription self-loop brake working). Both helpers stay `async` and keep their
names because every call site awaits them, but the delivery underneath is now a
synchronous bus emit that no slow WS client can stall.

Four things had to ride the twin or something breaks silently, all pinned by
`test_the_bus_twin_carries_everything_the_ws_dialect_did` (falsified: dropping
the counters fails it): `queued`/`active` (read off `_node_rt` at emit time,
stored nowhere else), `detail.process_id` (the only thing `proc-watch` attaches
to), the run-internal `kind: event` beats (the edge-pulse input, which the
boundary tags never carried), and `target` (how a client filters to one flow).

Consumers adapt the envelope at the subscription boundary in
`GraphWorkflowsView.tsx` rather than rewriting `store.ts` / `proc-watch.ts`:
`target` supplies `flow_id`, `data` supplies the rest. Two fixes fell out — the
TS `phase` union gained the `waiting` value the backend has always emitted
(`manager.py:739`), and the header "connected" dot now follows the real socket
instead of a one-shot bootstrap promise that could only ever resolve true.
`test_run_boundaries_emit_flow_tags` had its ORDERING assertion scoped to
boundary tags; its per-event `target`/`scope`/`run_id` invariants deliberately
still cover the twins.

Verified: 4556 backend unit tests pass; `ui` unit project 3083 pass (the one
failure, `cloud-manager-hub-identity`, reproduces on unmodified code).

## Phase 9 — Recorder + policy hardening  ☐

`EventBus.on("*", sink)` recorder interface; the four jsonl sinks (RunJournal,
trigger-log, transcript, I/O records) re-homed as instances of that subscriber
shape. `ctx.scope` delivery-authorization (role-walk-scope at delivery) — the
precondition for hub-origin events entering flows.

### Log

## Phase 10 — Vocabulary cleanup  ☐

Resolve the `toplog` collision (it uses "tags" for logging filters); enforce
the naming rule — anything still named `event`/`message`/`op` outside engine
internals is renamed or scheduled. End state: one word, one bus, emitters and
subscribers all the way down.

### Log

<!-- flowpad:capsule identity
version: 1
data:
  id: 668e2408-1e99-4fd8-91dd-414aab27cc11
flowpad:endcapsule identity -->
