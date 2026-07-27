---
id: 63c7ed4a-6b98-55ee-8d93-1aed343bc16d
---

# Hub Fan-out & Conversation Loader

This document traces a `FlowMessage` from the moment a sender's `add_message`
lands on the hub to the moment a recipient's browser renders the conversation
warm. Five stages: **hub fan-out** (who gets which frame, and why content and
status are asymmetric), the **OSS receive/upsert path** (`hub_bridge`), the
**materialize pipeline** (the single ordered write path), **conversation-list
reconcile/staleness** (client-side revival), and the **conversation loader
cascade** (the URL → entity → context resolution).

It supersedes the old root `DESIGN_loadConversation.md` — the loader rationale
from that design doc is folded into the [Loader cascade](#5-conversation-loader-cascade)
section below; that file can be deleted.

Related: the entity field semantics and `resolve_project_id` live in
[`./conversation-model.md`](./conversation-model.md); the `FlowMessage` record,
delivery UPDATE, and body bundle in
[`./messages-and-attachments.md`](./messages-and-attachments.md); roster/upsert
metadata and late-joiner sync in
[`./invites-members-identity.md`](./invites-members-identity.md); and the path
that produces the hub header in the first place in
[`./sharing-and-sync.md`](./sharing-and-sync.md).

## End-to-end picture

```
  SENDER machine            HUB (separate repo)                 RECIPIENT machine
  ─────────────             ───────────────────                 ─────────────────
  POST add_message ───────► add_message_action
                            ├─ stamp sender id/name (auth)
                            ├─ add_child(fm) + recompute
                            ├─ _fanout_message ─── CREATE ──────► hub_bridge._on_data_op
                            │   (skip sender)  from_entity=conv      └─► _handle_flow_message_op
                            │                                            └─► materialize_flow_message
   row: created → sent ◄─── _fanout_status_update                          ├─ ensure_conversation_entity
       (only_user_id=       ('sent', only sender)                          ├─ save FM  (CREATE emit)
        sender)                                                            └─ conv UPDATE (pointer→projection)
   ✓ ◄────────────────────  _fanout_status_update ◄──── auto-ack POST ◄── delivered/received
       (delivered/received   (skip sender iff status hidden)
        honor visibility)
```

The asymmetry is the load-bearing idea, and it repeats at every layer:
**content frames skip the sender** (the sender already has the row it just
posted), while **status frames target or honor the sender** depending on
visibility. Hold that distinction; the rest is bookkeeping.

## 1. Hub fan-out (HUB repo)

> The hub is a **separate checkout** at
> `/Users/shlom/Documents/dev/test_flowpad/FlowPad/`. Paths in this section are
> in the **hub repo**, not flowpad-oss.

`Conversation.add_message` (`flowpad/hub/builtin/conversation.py:107-123`) runs
after the message is accepted and stored. The hub has accepted it, so it is
`SENT` (one check on the sender's UI) — `CREATED` only ever exists client-side,
pre-accept (`conversation.py:108-113`). The sequence is:

```
add_message(fm):
  if rank(fm.delivery_status) < rank(SENT): fm.delivery_status = SENT   # :112
  add_child(fm); _recompute_message_count(); update()                   # :114-116
  _fanout_message(fm)                                                   # :117  CONTENT, skip sender
  _fanout_status_update(fm, only_user_id=fm.sender_id)                  # :122  STATUS, sender alone
```

### The common iterator — `_dispatch_to_participants`

Every `_fanout_*` method funnels through `_dispatch_to_participants`
(`conversation.py:233-265`). It walks `self.participants`, resolves each to a
`User`, gates on `is_notification_required(user, conv, msg)`, and pushes the
`DataOpMessage` over the websocket. Two mutually-exclusive knobs steer it:

- `skip_user_id` — short-circuits ONE participant (`conversation.py:258-259`).
  Content fanout passes the sender here.
- `only_user_id` — restricts the fan to a SINGLE participant
  (`conversation.py:256-257`). Used to push `sent` to the sender alone.

Per-participant `User.get_by_id` is the obvious profiling target — the code
flags it for batch-resolution if it ever shows (`conversation.py:248-249`).

### Content fanout skips the sender

`_fanout_message` (`conversation.py:267-281`) builds a `CREATE` with
`to_entity=fm.typeid` and, critically, **`from_entity=self.typeid`** (the parent
conversation), then dispatches with `skip_user_id=fm.sender_id`
(`conversation.py:281`). The `from_entity` envelope is what lets every
recipient's bridge map the message back to its parent conversation **without an
extra `parents_path` HTTP roundtrip** (which is policy-denied to the `member`
role anyway, `conversation.py:270-274`). The OSS bridge reads this exact field.

The sender is skipped because the hub's entity-save auto-notify already echoed
the row to the sender; re-delivering the content would be redundant (and arrives
without `from_entity`, so it would hit the denied fallback — see §2).

### Status fanout targets / honors the sender

Two distinct status pushes, with **inverse** sender handling:

1. **`sent` → sender alone.** Because content fanout skipped the sender, the
   sender would never learn its own message advanced `created → sent`. So
   `add_message` pushes `_fanout_status_update(fm, only_user_id=fm.sender_id)`
   (`conversation.py:118-122, 283-299`) to bump that one row.

2. **`delivered` / `received` → everyone, honoring visibility.** When a
   recipient auto-acks, the resulting status update fans to all participants —
   but `_fanout_status_update` applies the inverse skip: `skip = fm.sender_id if
   not self.message_status_visible else None` (`conversation.py:298`). With read
   receipts OFF the **sender** is the one skipped; with them ON everyone
   (sender included) sees the tick advance.

```
            sender skipped?   targets
  CREATE        YES           recipients               (content; sender already has it)
  sent          —             sender only              (only_user_id)
  delivered/    iff status    all, or all-but-sender   (visibility-gated inverse skip)
   received      hidden
```

`_fanout_message_delete` (`conversation.py:216-231`) is the deliberate
exception: op=`DELETE`, **no** sender skip — the deleter's other devices must
also drop the message, and `from_entity` still lets recipients prune their
pointer index.

## 2. OSS receive / upsert — `hub_bridge`

All inbound frames land on `HubBridge._on_data_op`
(`flow_sdk/cloud_client/hub_bridge.py:277-341`). It parses `to_entity`
(the changed entity) and `from_entity` (the parent envelope, `hub_bridge.py:285-289`),
then routes by type (`hub_bridge.py:296-319`):

```
_on_data_op(message):
  child_*                      → _handle_child_op       (envelope inverted: to=parent)
  to_entity.type == flow_message → _handle_flow_message_op(op, eid, data, parent_conv_id)
                                    parent_conv_id = from_eid iff from_entity is a conversation  # :311-313
  to_entity.type == conversation → _handle_conversation_op(op, eid, data)
  to_entity.type == invitation   → _handle_invitation_op (nudge → HTTP pull)
  always: _dispatch_event(...)   → generic cloud_watch subscribers                # :334-341
```

### `_handle_flow_message_op` (`hub_bridge.py:397-533`)

**Self-send drop (`hub_bridge.py:420-427`).** The hub fires *two* CREATE frames
per `add_message`: the entity-save auto-notify (no `from_entity`, broadcast to
the sender) and the explicit `_fanout_message` (with `from_entity`, to everyone
but the sender). The auto-notify copy is useless to us — we already know about
our own sends, and it lacks the conversation parent. The bridge matches
`payload.sender_id` against the **cloud** user id (`get_user()`, not the local
`User` row, which uses a different per-machine id) and **returns early** when
they match (`hub_bridge.py:424-425`).

**Conversation-id resolution (`hub_bridge.py:428-463`)**, in precedence order:

1. `payload.conversation_id` or the `parent_conv_id` from `from_entity`
   (`hub_bridge.py:428`).
2. Scan the wire context field — tolerating `shared_context_entities`,
   `context_entities`, and `context` during the field-rename transition — for a
   `conversation` entry (`hub_bridge.py:436-448`).
3. Last resort: a direct HTTP `parents_path` call that walks the ownership chain
   (`_fetch_conversation_id`, `hub_bridge.py:455-456`). WS `parents_path` isn't
   supported by the hub.
4. Still nothing → log and skip (`hub_bridge.py:459-464`).

**Background persist (`hub_bridge.py:475-533`).** Persistence runs in a detached
`asyncio.create_task(_persist_inbound())` to keep the bridge handler off the
critical path. It calls `materialize_flow_message(..., notify=True,
emit_live_create=True, remote=True)`. The history here matters: the bridge once
pre-emitted the CREATE for latency and called materialize with `notify=False` —
but `notify=False` *also* suppressed the Conversation UPDATE, so an already-open
view never re-rendered. Correctness won: **both** events go through materialize
(`hub_bridge.py:480-485`). A body-bearing prompt that is still `UPLOADING` is
deferred — its auto-run waits for the `body_status → READY` UPDATE, kept
idempotent by a `prompt_auto_handled` marker (`hub_bridge.py:510-527`).

**Eager bundle pull (`hub_bridge.py:540-546`).** Only when `body_status` is
already `ready` at CREATE time (sender uploaded before our bridge saw the
message). The READY transition for messages observed mid-upload arrives later as
an UPDATE.

### `_handle_conversation_op` (`hub_bridge.py:664-726`)

Passive upsert of lifecycle changes (title, status, participants, visibility,
remote-project, shared context). Two invariants:

**Strip projection-guarded fields before save (`hub_bridge.py:680-686`).** The
handler intersects the wire data against a `_LOCAL_FIELDS` allow-list and excludes
the `_PROJECTED` set, so a peer's stale `message_count`/`message_ids` can never
clobber the locally-projected ones (which only `project_pointers_to_entity` may
write — see [`./conversation-model.md`](./conversation-model.md) §The projection
guard).

**Anti-spoof `created_by` on insert (`hub_bridge.py:692-710`).** On create,
`created_by` is set to the hub's `initiated_by`, else `created_by`, else the
neutral `'system'` sentinel — **NEVER** the local user (`hub_bridge.py:701`),
which would surface received conversations as "created by me." (This WS path's
`'system'` fallback is the one that differs from the HTTP accept mirror, which
keeps `None`; see [`./conversation-model.md`](./conversation-model.md)
§`created_by`.) Save is `notify=True` so the FE re-renders. On update
(`hub_bridge.py:716-726`), allowed fields are merged in place and the hub owner
is adopted when it carries one.

### `_handle_child_op` — the generic child materialization kernel

`child_created` / `child_updated` / `child_deleted` ops (envelope inverted:
`to_entity`=parent, `from_entity`=child) route to `_handle_child_op`, which is a
thin shell around **the single receiver kernel** shared with the catch-up sync:
`Entity.upsert_from_hub_child` (`entity_model.py`). The kernel's contract is
**replication, not row-copying** — after it runs, the local replica is
query-equivalent to the sender's original:

1. **Row** — LWW upsert (`is_stale` on `updated_date`), `remote=True`, the
   child's own `parent_type_id` (e.g. the markdown doc) winning over the op's
   hub-container envelope (the conversation, used only for fanout/authz).
2. **Edge** — `ensure_child_edge()`: when the `parent_type_id` row exists
   locally, the parent→child `is_child` role edge is recreated (idempotently),
   exactly the edge the sender's `add_child` produced. Role-walk scope queries
   (the doc-comment gutter's `QueryRequest scope=[doc]`) resolve through this
   edge — a bare row save leaves the child invisible to them.
3. **Blobs** — blob fields (`raw_content` on comments) are db-excluded from hub
   rows and served only under `expand=blobs`. The live op usually embeds the
   in-memory entity (blobs included); when a blob-declaring type arrives with
   all blob fields empty, the bridge does one follow-up
   `hub_get(child, expand=blobs)` and merges before materializing
   (`hub_bridge.py::_handle_child_op`).

A child whose parent hasn't materialized yet (a layer-1-gated shared doc, not
yet installed) saves row-only; the **orphan rebind** pass of the catch-up sync
heals the edge when the parent lands (see §4a).

### §4a Catch-up subtree sync + rebind (`conversation-message-sync`)

Push is an optimization; **pull is correctness**. Each
`conversation-message-sync` call runs `_sync_shared_context_subtree`
(`flow_message_action.py`), which for every registry type flagged
`shared_child=True`:

1. pulls the conversation's hub children in one list call **with
   `expand=blobs`** (`_sync_remote_children`) and LWW-upserts each through the
   same kernel;
2. prunes local `remote` children whose hub row is confirmed gone
   (`_reconcile_deleted_children` — confirm-GET before prune guards the
   create/list-lag race);
3. **rebinds orphans** (`_rebind_orphan_children`): every remote child bound to
   the conversation or to a shared-context doc gets `ensure_child_edge()` — the
   only healer for children that synced before their parent existed (the LWW
   skip means such rows never re-materialize on their own).

## 3. Materialize pipeline

`flow_sdk/app/actions/materialize_flow_message.py` is the **single write path**
for `FlowMessage` records — every producer (REST POST, hub-mirror sync, bundle
unpack, draft send) routes through it so the ordering guarantee holds in exactly
one place (`materialize_flow_message.py:1-12`).

### Load-bearing order: FM CREATE → Conversation UPDATE

`materialize_flow_message` (`materialize_flow_message.py:153-324`) saves the FM
*before* it notifies the conversation, because the UI refetches the conversation
on the UPDATE and must already have the FM row to render
(`materialize_flow_message.py:165-175`):

```
materialize_flow_message(payload, conversation_id, remote, emit_live_create):
  1. upsert FlowMessage  (notify=False)                                   # :196-235
       existing + remote + is_stale → LWW merge_hub_payload, reflect      # :206-213
       new + remote → carry wire created_by verbatim, reflect             # :221-235
  2. emit explicit CREATE  iff (is_new OR emit_live_create)               # :246-251
  3. ensure conversation exists (bare build if caller skipped it)         # :254-264
  4. append typed Pointer → conversation.jsonl                            # :274-282
  5. project_pointers_to_entity(rec) → message_ids / message_count       # :283-284
  6. sniffer EVENTs + conv.notify_updated()                              # :286-320
```

Step 2's `emit_live_create` flag is the fix for the "doorbell rings once" bug: a
background catch-up that materialized the row first would otherwise swallow the
live CREATE, so body-bearing messages never reached the open conversation
(`materialize_flow_message.py:237-245`). The hub WS bridge always passes it.

The `remote=True` path preserves hub attribution via `remote_reflection()` (a
contextvar that suppresses the driver's local-user stamp) and applies the
LWW-by-`updated_date` invalidation rule (`FlowMessage.is_stale`,
`materialize_flow_message.py:181-186, 206-220`) so hub-owned fields refresh
while local-only state (body/download progress) is preserved.

### `ensure_conversation_entity` (`materialize_flow_message.py:40-150`)

Idempotent — returns the local Conversation, creating it if missing. On
**create**, it derives the owning project deterministically and once via
`Conversation.resolve_project_id([parent])` (`materialize_flow_message.py:83-86`)
— the same rule the local create path uses; an entity-less cross-user chat stays
project-less (`None`) by design. It carries the hub `created_by` **verbatim**,
sets `remote=True`, and reflects the save (`materialize_flow_message.py:88-108`).
On an **existing** row it only *backfills* participants, title, and the parent
`shared_context_entities` link when those are missing
(`materialize_flow_message.py:109-136`) — never overwriting a local override.
The parent backfill is what lets `firstContextOfType('task')` resolve on the
recipient, which the Implement-Plan / Approve-&-Execute chips gate on
(`materialize_flow_message.py:120-134`).

### Notifications (`materialize_flow_message.py:286-320`)

Two channels, two purposes:
- **Sniffer EVENTs** `flow_message_materialized` and `conversation_updated`
  (`materialize_flow_message.py:298-315`) — fired as `SyncOperation.EVENT`, NOT
  CRUD ops. (Sending them as CREATE/UPDATE once made the webhook receiver try to
  *construct* a FlowMessage from an event-shaped payload and fail with "text
  Field required.")
- **Entity-event** `conv.notify_updated()` (`materialize_flow_message.py:316-320`)
  — required for React `useEntity` hooks to re-render; the sniffer channel alone
  does not drive them.

## 4. Conversation-list reconcile & staleness

Staleness is resolved **client-side** — there is no server-maintained "open
list." `useRecentConversations` (`ui/src/hooks/use-recent-conversations.ts:20-30`)
queries all conversations, then filters `!dismissed_at && !archived_at` and sorts
by `updated_date` desc. Because the materialize pipeline (§3) bumps
`updated_date` on every inbound message, a conversation that was scrolled out of
view **auto-revives to the top the instant a newer message lands** — no explicit
"mark unread" state to maintain.

Context references are pruned by `useReconcileContext`
(`ui/src/components/conversation/useReconcileContext.ts:17-54`). On view-open it
fires the backend `reconcile-context` action **once per holder per session**
(guarded by a module-level `reconciledHolders` set, `useReconcileContext.ts:15,
40-49`) to drop references whose target is gone both locally and on the hub.
It subscribes to the holder's `entity_event` first (`useReconcileContext.ts:27-38`)
so it never misses the `context_refs_cleaned` event the reconcile may emit; on
that event it invalidates each removed TypeId (`useReconcileContext.ts:29-36`) so
cached "not found" refs drop and the muted chips disappear live. A failed
reconcile is non-fatal and drops the guard so a later mount retries
(`useReconcileContext.ts:43-48`).

## 5. Conversation loader cascade

The loader resolves a `/dock/conversation/<id>[/message/<id>]` URL into a fully
populated conversation plus `dataContext`. It is a two-tier split mirroring
`load-shell` / `load-project`: a pure primitive `loadConversation(id)`
(`ui/src/routes/loaders/load-conversation.ts:58-126`) and a URL-aware wrapper
`loadConversationRoute(pointer)` (`load-conversation.ts:132-179`).

```
loadConversation(id):
  Phase 1  conv = getByTypeId(Conversation, id)                # :61-77  HARD-required
             404/403 → throw ConversationLoadError('not_found')
             other   → throw ...('network_error')
  Phase 2  taskTypeId = conv.firstContextOfType('task')        # :80-84  silent-optional
             if present: task = getByTypeId(task).catch(null)
  Phase 3  projectId = task?.project_id                        # :92     CASCADE
                       ?? conv.project_id
                       ?? undefined
  Phase 4  dataContext.setActiveEntityTypeId(conv)             # :97
           projectId ? setContext(CurrentProject, project)     # :99-108
                       + prefetch Project (best-effort)
                     : setContext(CurrentProject, null)        # :109-119  → red "Select Project" pill
  Phase 5  if task?.project_root: setWorkdir(root)             # :121-123
```

### Why this shape (rationale folded from the old design doc)

- **Series, not parallel.** Project resolution *always* depends on the task
  (`task.project_id ?? conv.project_id`), so the task fetch must complete first.
  Parallelizing would only muddy error semantics — an active project with no
  active task is an inconsistent state.
- **Silent-fail on Task 404.** Conversations exist independently of tasks
  (project-scoped chats, hub-direct conversations, late-joiner shares all lack a
  parent task). A missing task has **zero** effect on rendering — the page looks
  identical whether the task loaded or never existed — so `firstContextOfType`
  returning null and the `.catch(() => null)` both just continue. No banner.
  Contrast `load-process`'s `project_missing`, which has a real runtime effect
  (broken PTY) and therefore *does* surface.
- **The `??` cascade is the whole project-resolution algorithm.** Task wins (it
  owns `project_root` for cwd); conv falls back (receiver-mapped project, set by
  the project-mapping gate); `undefined` → the StatusBar shows the red pill.
  Without the `conv.project_id` fallback, refreshing a task-less conversation
  would drop the project to null even though the conversation already knows its
  local Project (`load-conversation.ts:86-92`).
- **Cache-first, no refresh.** `message_ids` / `message_count` are projections
  the user never edits, and the task context link is stable, so refreshing the
  conversation just to re-check a possibly-deleted task adds latency for no
  payoff — the task fetch will 404 anyway if it's gone.
- **Project prefetch is best-effort.** Phase 4 warms the Project into cache so
  the StatusBar / `useEntity(Project)` hit immediately on first paint; a deleted
  project's `.catch(() => null)` is non-fatal (`load-conversation.ts:106-108`).
- **No loader-specific timeout.** Per CLAUDE.md, a slow fetch means slow code,
  not a too-short timeout — the loader inherits the global network timeout and
  never adds its own retry/backoff to mask a stall.

### Route wrapper

`loadConversationRoute` (`load-conversation.ts:132-179`) parses the pointer with
`DockPointer.parseConversationPointer` and **ignores the `/message/<id>` tail**
(`load-conversation.ts:139-143`) — that segment is view-level state the route
component derives from `currentDock`. It translates the typed error into a dock
resolution: `not_found` → a **hard** `DockLoadError` rendering "Conversation not
found" in-tab; `network_error` → a **soft**, retryable one
(`load-conversation.ts:147-178`). Any other error re-throws to the ErrorBoundary.

This URL → loader → context → render flow is the URL-first navigation invariant
from CLAUDE.md: the loader is the single writer of `dataContext`, and the active
conversation is derived from the URL, never from an optimistic click-handler write.
