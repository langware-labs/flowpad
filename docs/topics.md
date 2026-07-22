# Topics — the unified event bus

One event language spanning the whole app, front and back: entity changes, filesystem
changes, flow-engine boundaries, worker/agent status, compute-node liveness, and UI
interaction all speak it. The journey engine, triggers, and any future recorder are
ordinary subscribers.

**Naming rule (grep-able):** anything with `topic` in its name is the unified system
(`on_topic` / `onTopic`, `emit_topic` / `emitTopic`, `<family>.on_topic.py` /
`<family>.onTopic.ts`, `topic_msg`). Anything named `event` / `message` / `op` is legacy.

## Topic — a free ontological string

```
topic := dot-separated path, optionally prefixed with an ontology name
```

- **The bus does not interpret it.** A topic is just the event name — an opaque string
  matched segment-wise. No category/kind grammar, no closed taxonomy enforced by the
  system.
- Dot-separated so patterns can match by prefix: `entity.updated`, `flow.step.done`,
  `ui.clicked`, `myapp.onboarding.finished` — all equally legal.
- An ontology prefix namespaces vocabularies (a core ontology vs. app/user-authored
  ones) without the bus knowing or caring.
- Naming conventions (e.g. the core `entity.` / `ui.` / `flow.` / `agent.` / `node.` /
  `fs.` families below) live in the ontology as documentation — evolvable without
  touching the bus.

## Target — what the event is about

- `target` = the **type:id of the event's entity**. Its own envelope field, separate
  from the topic.
- Target form (`type:id`, colon serialization) is the one identity syntax, used in
  `target`, `actor`, and `scope` entries. It is the existing API target-entity concept
  (`to_entity`, watcher-registry keys) promoted to the whole system.
- Non-entity subjects (a wiki word, a vfs path) are expressible — a target may name any
  resolvable thing — but the canonical case is an entity id.

## Envelope

| Field       | Type          | Rule |
|-------------|---------------|------|
| `id`        | uuid4         | minted at emit (standard minter); never rewritten on relay |
| `timestamp` | ISO-8601 UTC  | stamped by the emitter; ordering hint, not a guarantee |
| `topic`     | string        | the event name — free dot-separated ontological string |
| `target`    | target form   | the entity the event is about |
| `data`      | object        | payload; UI-originated events **never** carry user-entered values |
| `ctx`       | object        | correlation only — enriches, never gates |

## ctx

| Field    | Form | Answers |
|----------|------|---------|
| `actor?` | target form (`user:<id>`, `agentic_process:<id>`, `system`, `hub`) | who caused it — the one non-derivable attribution (user vs agent action) |
| `scope`  | list of targets, **innermost-first** | where in the world — same data and semantics as existing scope handling (`QueryRequest.scope`, role-walk-scope); doubles as the delivery-authorization input |
| `origin` | `app` \| `local_server` \| `hub` \| `sandbox` | which tier emitted — **required**; trust policy per tier (sandbox least trusted) |

No `emitter` field — convention: *the producing entity is the target or the innermost
scope entry.* No `cause` field. A relay never rewrites `actor`; `origin` reflects the
arriving hop.

## Bus API — identical shape, both SDKs

```
EventBus.emit(topic, target, data?, ctx?)                    # fire-and-forget; fills id/timestamp/origin
EventBus.on(topic_pattern, handler, {target?, scope?}) → unsub
```

- **Topic patterns**: segment-wise glob over the dot path — `entity.updated`,
  `entity.*`, `flow.step.*`, `*`.
- **Target / scope** are optional delivery filters, not part of the topic match —
  `target: "agent:1234"` (this one), `target: "agent:*"` (any of the type),
  `scope: [project:X]`.
- **Sugar** (string/filter builders over the core, nothing more):
  - instance: `entity.on_topic("entity.updated", h)` → subscribe with `target = self`
  - type: `Agent.on_topic("entity.created", h)` → `target = agent:*`
  - emit: `entity.emit_topic(topic, data)` → target from `self`
- **Adapter files**: each legacy family gets a small, deletable bridge named
  `<family>.on_topic.py` / `<family>.onTopic.ts` beside it.

## Laws

1. **The bus matches `topic` (+ optional target/scope filters); it never interprets
   meaning.** Semantics live in the ontology, not the transport.
2. **At-least-once, unordered across topics; handlers idempotent** (the journey's
   stale-cursor no-op discipline, generalized to a bus law).
3. **Handler isolation** — emit is sync-fast and never awaits consumers; one failing
   subscriber never blocks emit or peers.
4. **No durability in the bus** — persistence is a subscriber's job (the recorder
   pattern).
5. **Event ≠ proof** — an event says *check now*; state says *it's true*. Gating
   consumers (journey awaits, triggers) confirm against the store before acting.
6. **Cross-tier forwarding is by subscription, never ambient** — `app` → `local_server`
   only for declared patterns (allowlist); backend → app rides one WS frame,
   `message_type: "topic_msg"`. No click-storm crosses a boundary nobody subscribed to.

## Legacy adapters (the seven existing pipelines, mapped)

| Chokepoint | Emits |
|------------|-------|
| `DBEntity.save` / `notify_updated` / `delete` | `entity.created/updated/deleted`, target = `to_entity`, scope += `from_entity` — **dual-published**; legacy `data_op_msg` invalidation untouched |
| `fsop_watcher._fire` | `fs.added/modified/deleted`, target = the path's asset (or vfs ref); Triggers become `(pattern, target?, scope?)` subscriptions |
| `FlowManager` boundaries (`_broadcast_*`) | `flow.started/waiting/done/failed`, target = the flow/journey entity, run/node detail in `data`; run-*internal* routing stays inside the engine; inbound, `inject`/`$external` = how a bus event enters a run |
| Worker status tick | `agent.status`, target = the AgenticProcess (status enum in `data`) |
| Heartbeat / hub link / compute registration | `node.connected/disconnected/heartbeat/status`, target = the ComputeNode — replaces today's three-mechanism spread |
| Hub bridge (`_dispatch_event`) | relays inbound hub events with `origin: hub`, `actor` preserved |
| UI: one global capture-phase listener on topic-tagged elements + the `openDock` chokepoint | `ui.clicked/navigated/signal`, target = the tagged element's resolved entity/named topic, `origin: app|sandbox`. One tag makes an element highlightable (wiki highlight), observable, and routable |

**Journey awaits collapse onto the bus**: `page_signal` → `ui.signal`,
`entity_query` → `entity.created` + confirm-predicate, `dock_reached` → `ui.navigated`,
`process_status` → `agent.status` — each filtered by target; `manual` stays the
universal escape hatch.

## Recorder (future, designed-for)

`EventBus.on("*", h)` writing envelopes to a sink — nothing more. The four existing jsonl
sinks (RunJournal `runs/*.jsonl`, the FSOp trigger-log, transcript jsonl, run I/O
records) are precedent instances of this subscriber shape. The no-input-values law keeps
it safe to exist. Not built now.

## Migration order (strangler — legacy message types keep working throughout)

1. Envelope + bus core on both sides + the `topic_msg` WS frame (contract tests first)
2. **Entity adapter** — one chokepoint, biggest coverage, concepts already match
3. Flow-engine boundary events
4. UI normalizer + journey awaits re-based on the bus (deletes the bespoke await
   machinery)
5. Compute-node liveness unification
6. Recorder interface stub
