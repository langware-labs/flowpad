---
id: a92e3231-5645-518c-b65b-a2ae5ba6ff65
---

# Conversation Model

The `Conversation` entity (`flow_sdk/builtin/conversation.py:96`) is the durable
spine of the collaboration subsystem: a thread of `FlowMessage`s that can be
shared to the hub, fanned out to other machines, and re-projected on receipt.
This document covers the entity's field *semantics*, the projection invariant
that protects message state, the deterministic project-resolution algorithm, and
the ownership model — and the WHY behind each.

It does **not** cover the roster/invite mechanics (see
[`./invites-members-identity.md`](./invites-members-identity.md)), the message
record itself (see [`./messages-and-attachments.md`](./messages-and-attachments.md)),
or the hub-side fan-out and receive loader (see
[`./hub-fanout-and-loader.md`](./hub-fanout-and-loader.md)). For the underlying
record/index machinery see [`../data-management/record-model.md`](../data-management/record-model.md);
for `TypeId` grammar see [`../typeid.md`](../typeid.md).

## Position in the stack

```
conversation.jsonl  ──projection──►  Conversation (DB row)  ──render──►  UI
  (source of truth)                    message_ids / message_count
  one pointer per FlowMessage          + title/kind/participants/…
```

The on-disk `conversation.jsonl` pointer index is the source of truth for
*which* messages belong to a conversation and in what order. The DB `Conversation`
row is a rebuildable index over it. Message *content* never lives on the
conversation; each pointer resolves to an independent `FlowMessage` record fetched
by id.

## Entity schema & field semantics

Defined at `flow_sdk/builtin/conversation.py:109-153`. The interesting fields are
the ones whose meaning is not obvious from the type:

### `title` (`:110`)
Optional human label. Nullable; the UI falls back to `(untitled)`.

### `kind` / `ConversationKind` (`:14`, `:116`)
`DIRECT` (default) is an ordinary 1:1 or group thread. `COMMUNITY` marks a
support-center "ticket": a guest opens it against the canonical community project
and staff replies are displayed under the project's single
`community.display_name` identity rather than the individual responder. The field
is **hub-authoritative** — stamped by `Project.start_guest_conversation` on the
hub and **never** honored from a client-supplied payload (anti-spoof). Treat any
`kind` arriving in a client write as untrusted.

### `created_by` (`:126`)
The hub-side owner, mirroring `Conversation.initiated_by` on the hub. Consumed by
`handle_conversation_delete_archived` to classify an archived row as own-delete vs
leave vs decline. **It MAY be null:** the hub only stamps `initiated_by` for
project-created conversations, so share- and diagnostics-created conversations
carry no owner. The two receive paths handle that gap differently — the HTTP
accept/upsert mirror (`_upsert_hub_conversation_metadata`) preserves `None`
*verbatim*, while the passive WS upsert substitutes a neutral `'system'` sentinel
(see [`./hub-fanout-and-loader.md`](./hub-fanout-and-loader.md) §`_handle_conversation_op`).
Neither path ever stamps the *local* user. Because `created_by` is thus
unreliable as an owner key, every `created_by ==` comparison is written null-safe
and ownership for display/authz resolves from the roster (see
[Ownership](#ownership-semantics)), not from this field.

### `remote_project_id` / `remote_project_name` (`:127-128`)
The *sender's* project identity, carried across the machine boundary. A project id
is local to one machine, so these preserve "which project this came from over
there" for display and for the receiver's own project mapping. They are descriptive
metadata, never used as a local foreign key.

### `participants` (`:131`)
The roster, shape `[{user_id, email, name, role}]`. This is the authoritative
membership + role list and the basis for ownership/authz decisions. Roles
(`owner`, `member`, …) are detailed in
[`./invites-members-identity.md`](./invites-members-identity.md).

### `message_count` / `message_ids` (`:129-130`)
**Projections** of `conversation.jsonl`, never authored directly — see
[The projection guard](#the-projection-guard). `message_ids` is a JSON-encoded
list of typed pointers `[{"typeid": "flow_message-<id>", "ts": "<ISO>"}, …]`
ordered oldest-first by jsonl append order; `message_count` is its length.

### Message-status sharing
Receipt sharing is not Conversation state. Each FlowPad installation controls
whether it emits `delivered` and `received` acknowledgements through
`preferences.notifications.share_message_status`. Existing receipt data remains
visible, and the preference does not affect acknowledgements shared by peers.

### `dismissed_at` (`:139`) vs `archived_at` (`:145`)
Two independent suppression clocks with the same **auto-revive** semantics:
hidden *until* a `FlowMessage` newer than the timestamp lands, at which point new
activity revives the row.

```
dismissed_at  → hides from the Recent Conversations STRIP only; Inbox ignores it.
archived_at   → hides from BOTH the Inbox and the Recent strip.
```

Per-message `FlowMessage.is_read` is orthogonal and unaffected by either.

### `remote`
Inherited from `Entity`; the comment at `:146-149` flags that it is meaningful for
conversations specifically: `True` once `share()` has created the hub-side mirror
(same id), after which replies route through the bridge. `task_id` is **not** a
field — it now lives in `shared_context_entities` (see [Ownership](#ownership-semantics)).

## The projection guard

The single most important invariant: `message_ids` and `message_count` are
**derived state**, writable only by the projection writer. This is enforced
structurally, not by convention.

`_PROJECTED_FIELDS = {"message_ids", "message_count"}` and a module-level
`_PROJECTION_SENTINEL` object are declared at `conversation.py:36-38`. The entity
overrides `__setattr__` (`:565-574`):

```
__setattr__(key, value):
    if key in _PROJECTED_FIELDS and not self._allow_projection_write:
        raise AttributeError("…write via the projection writer, not directly")
    super().__setattr__(key, value)
```

The only sanctioned writer is `_set_projection(key, value, sentinel)`
(`:590-598`): it checks `sentinel is _PROJECTION_SENTINEL` (else `PermissionError`),
flips the `_allow_projection_write` latch via `object.__setattr__`, performs the
write, and clears the latch in a `finally`. Application code cannot reach the
sentinel, so it physically cannot author these fields.

The sole legitimate caller is `project_pointers_to_entity(rec, notify)` in
`flow_sdk/fs_store/operations/conversation.py:150` (it calls `_set_projection` at
`:205-206`). It reads the jsonl pointer index, recomputes `message_ids`/`count`,
sets recency from `max(FlowMessage.updated_date)`, and saves — guarded by a
change check so an unchanged projection is a no-op. This is the function the
hub fan-out and receive paths invoke as bundles are unpacked
(`flow_message_action.py`, `materialize_flow_message.py`); see
[`./hub-fanout-and-loader.md`](./hub-fanout-and-loader.md).

> NOTE: the entity docstring and some call sites refer to this writer as
> `ConversationRecord.sync_to_db`. There is no `ConversationRecord` class in the
> tree today; the live writer is `project_pointers_to_entity`. Same contract,
> renamed.

One leak to plug: generic graph CRUD round-trips the whole entity dump on every
save, which includes the projection fields. `apply_field_updates` (`:576-588`)
silently strips `_PROJECTED_FIELDS` from inbound PUT/PATCH bodies so a normal save
doesn't trip the guard — keeping CRUD working without making the guard leaky.

## The project-resolution algorithm

A conversation's owning `project_id` is computed **once, deterministically, at
every init point** (local create, share, hub receive) via the single classmethod
`resolve_project_id` (`conversation.py:155-184`). The rule: the project follows
the *shared/target entity*, never the client's ambient "active project".

```
resolve_project_id(shared_context_entities, *, fallback=None) -> str | None:
    for ref in shared_context_entities or []:
        tid = _coerce_context_typeid(ref)          # :79
        if tid is None or not tid.id:
            continue
        proj = await Entity.project_id_of(tid.type, tid.id)   # shared primitive
        if proj:
            return proj                            # first non-null wins
    return fallback                                # explicit scope, else None
```

`_coerce_context_typeid` (`:79-93`) normalizes the heterogeneous wire shapes a
context ref can take — a `TypeId`, a `"<type>-<id>"` string, or a
`{"type","id"}` dict — into a `TypeId`, returning `None` for anything
unparseable. `Entity.project_id_of` (`entity_model.py:2084`) is the same primitive
Tab project derivation uses, so a conversation and its tab agree on project by
construction.

Resolution order and the deliberate `None` tail:

```
1. first shared-context entity that resolves to a project   → that project
2. else the explicit `fallback` (a request/scope project_id) → fallback
3. else None  ── a pure entity-less cross-user chat is left  → None
                 project-less BY DESIGN; the receiver maps a
                 project for that one case, separately.
```

The `None` case is intentional, not a bug: an entity-less direct chat between two
users has no shared entity to anchor a project, and forcing one would mis-file it.
The receiver side handles project mapping only in that scenario.

## Ownership semantics

Ownership for display and authorization resolves from the **participant roster's
`owner` role**, not from `created_by ==` identity checks. The reasons:

- `created_by` MAY be null (share/diagnostics conversations), so an equality check
  against it is unreliable — hence all such checks are null-safe.
- `created_by` is a *local* user uuid on the creator's machine but a *cloud-user*
  id when mirrored from the hub; it is not a stable cross-machine owner key.
- The roster is the cross-machine authoritative membership list, carried in
  `participants`, and `role == "owner"` is the same signal the hub gates on.

So: to ask "is this user the owner?", walk `participants` for the `owner` role —
do not compare ids. (Details and the roster's hub/local/UI three-way resolution
live in [`./invites-members-identity.md`](./invites-members-identity.md).)

### `task_id` lives in shared context

There is no `task_id` field. The conversation's parent task is one of its
`shared_context_entities`, read back via:

```
conv.first_context_of_type('task', bucket='shared')   # entity_model.py:2295
```

This unifies "the task this conversation is about" with every other shared anchor
(markdown, skill, agent), so the project resolver above treats the task like any
other context entity — no special-casing.

## Control / data flow summary

```
create / share / receive
        │
        ├─ resolve_project_id(shared_context_entities, fallback)   ── once, here
        │
        ├─ share():  super().share() → hub mirror (same id, remote=True)
        │            link docs as children, push skill/agent nodes,
        │            invite recipients (MembershipRequest per email)
        │
        ▼
conversation.jsonl  ◄── append FlowMessage pointer (source of truth)
        │
        ▼
project_pointers_to_entity(rec)   ── ONLY writer of message_ids/count
        │   (via _set_projection + sentinel)
        ▼
Conversation row  ── updated_date = max(message.updated_date) ── inbox order
        │
        ▼
UI (Inbox / Recent strip)   ── dismissed_at / archived_at gate visibility
```

Every arrow that mutates message state passes through the jsonl index and the
projection writer; nothing writes `message_ids`/`message_count` directly. Every
arrow that decides "which project / who owns this" reads the shared entity or the
roster, never ambient client state. Those two disciplines — projection as the only
message-state writer, derived-not-ambient ownership/project — are the load-bearing
invariants of the conversation model.
