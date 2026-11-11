---
id: c3e9416c-2a1c-45d7-9e29-f0e813f29159
---

# Tags — the unified event bus

> **Delivery status lives in [flow-events.md](flow-events.md)** — the phased
> worklog. The consolidating envelope name is **`FlowEvent`**; this document
> remains the language rationale.

One event language spanning the whole app, front and back: entity changes, filesystem
changes, flow-engine boundaries, worker/agent status, compute-node liveness, and UI
interaction all speak it. The journey engine, triggers, and any future recorder are
ordinary subscribers.

**Naming rule (grep-able):** anything with `tag` in its name is the unified system
(`on_tag` / `onTag`, `emit_tag` / `emitTag`, `<family>_on_tag.py` / `<family>.onTag.ts`, `tag_msg`). Anything named `event` / `message` / `op` is legacy.

## Tag — a free ontological string

```
tag := dot-separated path, optionally prefixed with an ontology name
```

- **The bus does not interpret it.** A tag is just the event name — an opaque string
  matched segment-wise. No category/kind grammar, no closed taxonomy enforced by the
  system.
- Dot-separated so patterns can match by prefix: `entity.updated`, `flow.step.done`,
  `ui.clicked`, `myapp.onboarding.finished` — all equally legal.
- An ontology prefix namespaces vocabularies (a core ontology vs. app/user-authored
  ones) without the bus knowing or caring.
- Naming conventions (e.g. the core `entity.` / `ui.` / `flow.` / `agent.` / `node.` /
  `fs.` families below) live in the ontology as documentation — evolvable without
  touching the bus.

The string grammar itself has one owner: `flow_sdk/tags/grammar.py` and its byte-parallel
twin `ts_sdk/src/tags/grammar.ts`, pinned by the `grammar` section of
`tests/fixtures/flow_event_contract.json`. It serves every dot-separated vocabulary —
bus tags, subscription patterns, and the Artifact/Deployment `kind` ontology
(`worldview/ontology.py` and `models/Kind.ts` are compat shims over it). Two match
semantics live there and are never merged: `tag_matches` (subscription glob, `*`
segments, trailing `*` = suffix) and `tag_is_within` (hierarchy prefix — `workload`
contains `workload.service.http`).

## Taxonomy layer — describes, never routes

A tag name can also be *blessed*: given a `Tag` entity (`flow_sdk/builtin/tag.py`)
carrying a title, description, and namespace ownership. This is enrichment, not
registration — **the system works entirely with anonymous tags**, and law 1 holds
unchanged: the bus never consults an entity to route.

- **Identity is the name.** `id = mint_uuid("tag:<canonical name>")` (uuid5), so
  blessing the same name on any instance — or long after it was first emitted
  anonymously — converges on the same entity, and hub sync dedupes for free.
- **Resolution is wiki-link-shaped**: `resolve_tag(name) → Tag | None`. `None` is a
  supported state, and resolution **never mints** — an event storm must not become an
  entity storm. Blessing is deliberate (a seeder, an author, the gardening UI).
- **The hierarchy is derived, never stored.** `grammar.tag_tree` reconstructs
  parent/child from the dot-path, including implied intermediate names. There is no
  tag-edge table.
- **System vocabulary** ships as `SYSTEM_TAG_SEED` and is upserted at server startup;
  `RESERVED_ROOTS` (derived from that seed) blocks non-system creation under a system
  family. The gate is entity save-validation keyed on in-process seeding provenance —
  never a client-writable field, and never the bus.
- **User worlds** take a `--<namespace>--` first segment (`--acme--.orders.created`).
  The marker is legal only as segment 0; global uniqueness is a hub concern, not a local
  one. `grammar.split_namespace` reads it and `grammar.join_namespace` writes it — one
  owner, with a TS twin each and both directions pinned by the event-contract fixture.
- **The kind ontology uses the same marker**, and is its first live consumer: an
  externally authored asset declares an `ns` and every shape its code registers is
  prefixed with it, so a user-written driver cannot claim a kind a shipped one already
  names. **Ours is the default and it is silent — `--flow--` is never written.** See
  [`ontology.md`](ontology.md).

## Binding things to tags — the carriers ARE the store

Things point *at* tags; nothing points back. The join is derived at query time, so a
moved file or renamed doc can't leave a dangling edge.

| Carrier | Where | Binds |
|---------|-------|-------|
| an entity's `tags` field | EVERY entity type | the entity to what it is about |
| `tag` capsule (line-comment block) | a source file | code to the subjects it implements |
| `[[dot.tag.name]]` | any wiki body | a mention (blessed tags resolve by canonical name) |

### An entity's `tags` — the one classification field

`Entity.tags` is a list of tag names: what the thing is ABOUT, many, attached. (Its
`kind` says what shape it IS: one, derived — [`ontology.md`](ontology.md).) There is
no second field: `labels` is gone, and the two things it held have their own
(`Annotation.subkind`, `User.desktop` / `name_overridden`).

- **A stored tag is always valid.** Every way in — a file header, an API save, the
  CLI — converts through `grammar.to_tags`: `Meeting Notes` becomes `meeting-notes`,
  `project/alpha` becomes `project.alpha`, what cannot be a tag is dropped. `to_tag`
  is the lenient door for a name a person typed; `normalize_tag` stays the strict
  gate for a kind and for a `Tag` entity's name.
- **One write door:** `Entity.set_tags` (`add_tag` / `remove_tag`), reached as
  `POST|DELETE /graph/<type>/<id>/tags/<name>` and `flow tag add|remove <name> <type-id>`.
  The action is `tags`, not `tag`: `tag` is an entity type.
- **Where the tag is kept follows the type.** A type whose file header declares
  `tags` (a doc, a task, a skill) keeps them in that file, so they travel with it.
  Every other type keeps them in the row and its record shadow (`Persist.TRUE`):
  private to this machine, never written into the asset's file, and back after a
  full index rebuild. Tags are not sent to the hub.
- **Attaching never blesses.** A tag under a system root (`agent.review`) can be
  attached to anything; only creating the `Tag` entity for it is reserved.
- **Reading:** `Entity.has_tag("crm")` and the search `tags` filter match a tag or
  anything under it (`crm` finds `crm.lead`). `GET /api/v1/tags/names` lists the
  blessed names and the ones in use, for the input that suggests them.

A source file carries one `tag` capsule **per annotated position** (the name is
repeatable — see `docs/data-management/asset-capsules.md`), so a test module
points each of its tests at its own subject and every block reports its own line.

`flow tag <name> get [--mode line|block|full]` assembles that join for an agent:
blessed header plus ancestors, bound docs, every other tagged entity, capsule-carrying
code sites, and wiki mentions. The three modes are LLMIndex's summary tiers (`flow_sdk/llm_index/sizes.py`),
resolved without an LLM call. The `tag-context` skill teaches agents the trigger (a
capsule or `tags:` in a file you are about to change) and the line → block → full
escalation. Asking for a tag includes its descendants (`tag_is_within`).
`flow tag create <name>` blesses a name from the CLI (generic `POST /graph/tag`;
idempotent by uuid5-of-name), and the `tagit` skill is the writer that produces
both carriers at once — a rules doc plus a `breadcrumb.test.*` capsule on the
failing test it explains.

The same derivation renders as a graph: the `tag` subgraph projection
(`flow_sdk/tags/graph.py`) emits taxonomy `child` edges (hierarchy) plus `bound` edges
(association, with a `via` property naming the carrier), with anonymous tags and code
files as ghost nodes. It is served through the generic entity-subgraph route
(`/api/v1/subgraph/{projection}`) and viewed at `/dock/tag/graph[/<name>]`.

## Target — what the event is about

- `target` = the **type:id of the event's entity**. Its own envelope field, separate
  from the tag.
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
| `tag`     | string        | the event name — free dot-separated ontological string |
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
EventBus.emit(tag, target, data?, ctx?)                    # fire-and-forget; fills id/timestamp/origin
EventBus.on(tag_pattern, handler, {target?, scope?}) → unsub
```

- **Tag patterns**: segment-wise glob over the dot path — `entity.updated`,
  `entity.*`, `flow.step.*`, `*`.
- **Target / scope** are optional delivery filters, not part of the tag match —
  `target: "agent:1234"` (this one), or a trailing-`*` prefix glob: `agent:*`
  (any of the type), `dock:shell/*` (any pointer under the view);
  `scope: [project:X]`.
- **Sugar** (string/filter builders over the core, nothing more):
  - instance: `entity.on_tag("entity.updated", h)` → subscribe with `target = self`
  - type: `Agent.on_tag("entity.created", h)` → `target = agent:*`
  - emit: `entity.emit_tag(tag, data)` → target from `self`
- **Adapter files**: each legacy family gets a small, deletable bridge named
  `<family>_on_tag.py` (Python — dots don't make importable modules) /
  `<family>.onTag.ts` (TS) beside it.

### Another process's events — `POST /api/v1/tags/relay`

The bus is per process, and the app's bus is the one with the TAG triggers and the
clients. A process of the instance that is not the app — a project's server, a
trigger's `run_script` — puts its own event there by posting an envelope to the app:

```
POST /api/v1/tags/relay
{"tag": "user_app.qa.worker.silent", "target": "<type:id>", "data": {...}}
```

- **`user_app.*` is the family for such events.** Flowpad never emits it. A TAG trigger
  catches it (`"tag": {"on": "user_app.qa.*"}`), and the app's clients get it as a
  `tag_msg` frame.
- **Only the relayed patterns are taken** (`tags/relay.py RELAYED_TAG_PATTERNS`); any
  other tag answers 400. The relay is not a way to inject any tag into the app.
- `target`, `data` and `ctx` are optional and kept as sent. The app emits the event on
  its own bus, so it gets a new `id`.
- The app's port is in the instance's `server.json`. A gated instance (a cloud box)
  also wants its cookie-gate secret ([`cookie-gate.md`](cookie-gate.md)). Best-effort:
  if the app is not up, the event is lost.

## Laws

1. **The bus matches `tag` (+ optional target/scope filters); it never interprets
   meaning.** Semantics live in the ontology, not the transport.
2. **At-least-once, unordered across tags; handlers idempotent** (the journey's
   stale-cursor no-op discipline, generalized to a bus law).
3. **Handler isolation** — emit is sync-fast and never awaits consumers; one failing
   subscriber never blocks emit or peers.
4. **No durability in the bus** — persistence is a subscriber's job (the recorder
   pattern).
5. **Event ≠ proof** — an event says *check now*; state says *it's true*. Gating
   consumers (journey awaits, triggers) confirm against the store before acting.
6. **Cross-tier forwarding is by subscription, never ambient** — `app` → `local_server`
   only for declared patterns (allowlist); backend → app rides one WS frame,
   `message_type: "tag_msg"`. No click-storm crosses a boundary nobody subscribed to.

## Legacy adapters (the seven existing pipelines, mapped)

| Chokepoint | Emits |
|------------|-------|
| `DBEntity.save` / `notify_updated` / `delete` | `entity.created/updated/deleted`, target = `to_entity`, scope += `from_entity` — **dual-published**; legacy `data_op_msg` invalidation untouched |
| `fsop_watcher._fire` | `fs.added/modified/deleted`, target = the path's asset (or vfs ref); Triggers become `(pattern, target?, scope?)` subscriptions |
| `GraphWorkflowManager` boundaries (`_broadcast_*`) | `flow.started/waiting/done/failed`, target = the flow/journey entity, run/node detail in `data`; run-*internal* routing stays inside the engine; inbound, `inject`/`$external` = how a bus event enters a run |
| Worker status tick | `agent.status`, target = the AgenticProcess (status enum in `data`) |
| Heartbeat / hub link / compute registration | `node.connected/disconnected/heartbeat/status`, target = the ComputeNode — replaces today's three-mechanism spread |
| Hub bridge (`_dispatch_event`) | relays inbound hub events with `origin: hub`, `actor` preserved |
| UI: one global capture-phase listener on tag-annotated elements + the `openDock` chokepoint | `ui.clicked/navigated/signal`, target = the tagged element's resolved entity/named tag, `origin: app|sandbox`. One tag makes an element highlightable (wiki highlight), observable, and routable |

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

1. Envelope + bus core on both sides + the `tag_msg` WS frame (contract tests first)
2. **Entity adapter** — one chokepoint, biggest coverage, concepts already match
3. Flow-engine boundary events
4. UI normalizer + journey awaits re-based on the bus (deletes the bespoke await
   machinery)
5. Compute-node liveness unification
6. Recorder interface stub

