---
id: b27cd997-c564-573a-bf9c-ac5fa323b555
---

# Collaboration

This section documents flowpad's **collaboration subsystem** — the entities and
flows that let a knowledge worker share live context with a teammate and converse
about it across machines: conversations, messages, attachments, sharing, invites,
participants, sender identity, and the hub fan-out that ties two instances
together.

The subsystem is built on a single discipline: **disk + the hub are the source of
truth; every local DB row is a rebuildable projection.** Message membership lives
in `conversation.jsonl`; identity and roles live in the hub-authoritative roster;
the local `Conversation`/`FlowMessage` rows are indexes that the receive and
projection paths reconstruct. Read the docs below in order — each builds on the
invariants established by the previous one.

## Entity map

```
                          ┌──────────────────────────┐
            owner/member  │      participants[]      │  roster (hub-authoritative)
        ┌─────────────────│  {user_id,email,name,    │  → identity & authz
        │                 │   role}                  │
        │                 └────────────┬─────────────┘
        ▼                              │ embedded
  ┌───────────┐   first message   ┌────┴──────────┐   share/invite   ┌────────────┐
  │   User    │◄──── sender ──────│  Conversation │─────────────────►│ Invitation │
  │ (address  │                   │               │                  │  (pending  │
  │   book)   │                   │ shared_context│                  │   member)  │
  └───────────┘                   │  _entities[]  │                  └────────────┘
                                  └───┬───────┬───┘
                jsonl pointer index   │       │  shared anchors (parent_type_id)
                (source of truth)     │       └────────► Task / Markdown / Skill / Agent …
                                      ▼                  (effective-remote → auto-share)
                              ┌───────────────┐
                              │  FlowMessage  │  content; delivery + body FSMs
                              │               │
                              │ attachments[] │──► TYPE_ID | FILE | REPO | URL | PROMPT
                              │ body transfer │──► copy | git
                              └───────────────┘
```

`Conversation` is the spine; `FlowMessage`s hang off its jsonl pointer index (and
are *projected* into `message_ids`/`message_count`, never written directly).
Attachments are embedded in a message. `participants` is the hub roster.
`Invitation` is a pending membership. Shared context entities (task, markdown,
skill, …) are anchored to the conversation and recursively auto-share.

## Documents

1. **[Conversation Model](./conversation-model.md)** — the `Conversation` entity:
   field semantics, the projection guard (`message_ids`/`message_count` are
   derived state), the deterministic `resolve_project_id` algorithm, and
   roster-based ownership.
2. **[Messages & Attachments](./messages-and-attachments.md)** — `FlowMessage`,
   the `AttachmentType` taxonomy, the body-bundle lifecycle (`BodyStatus`), and
   the monotonic delivery state machine (`PENDING_SEND → … → RECEIVED`).
3. **[Sharing & Sync](./sharing-and-sync.md)** — the unified share dialog (many
   surfaces → one `ShareSource`), the three backend share paths (new / reply /
   forward), the `Conversation.share()` hub-invite sequence, and recursive share
   via the effective-remote parent chain.
4. **[Invitations, Members & Sender Identity](./invites-members-identity.md)** —
   the `Invitation` entity, the invite → accept → join algorithm, the role
   ladder, late-joiner history sync, and the hub-authoritative sender-identity
   model (resolution chain + unresolved-sender alert).
5. **[Hub Fan-out & Conversation Loader](./hub-fanout-and-loader.md)** — how a
   local message reaches the hub and fans out (content-skips-sender,
   status-honors-sender), the OSS receive/upsert path, the materialize pipeline,
   conversation-list reconcile/staleness, and the URL-first conversation loader
   cascade. (Supersedes the old root `DESIGN_loadConversation.md`.)

## Glossary

- **`remote` / effective-remote** — a conversation is `remote` once `share()`
  created its hub mirror (same id). A *child* entity (a doc, a comment) is
  *effective-remote* when an ancestor is remote, which is what makes shared
  context recursively auto-share.
- **`shared_context_entities`** — the conversation's anchored entities (task,
  markdown, skill, agent, …). Drives project resolution and recursive share; the
  parent task lives here, not in a `task_id` field.
- **projection** — `message_ids`/`message_count` recomputed from
  `conversation.jsonl` by `project_pointers_to_entity`
  (`flow_sdk/fs_store/operations/conversation.py:150`); the *only* sanctioned
  writer. Direct mutation raises.
- **body bundle** — the `.flowmsg` zip carrying a message's attachment payload,
  uploaded/downloaded out-of-band; gated by `BodyStatus` (NA | UPLOADING | READY).
  In normal `copy` mode this includes file/entity bytes. In `git` mode, git-backed
  entities carry metadata plus `GitOrigin` and the receiver reads bytes from a
  matching checkout instead.
- **`GitOrigin`** — a value object, not an entity. It names an upstream repo,
  branch/head, and safe repo-relative asset path. It is the single git pointer
  used by git-backed shares, project setup, and artifact resolution.
- **git transfer** — a body-bundle transfer mode where the message carries
  declaration metadata (`metadata.json`, `git_origins.json`, `git_transfers.json`)
  but does not copy git-backed file bytes. Receive means fetch/pull/clone as
  needed, index from the local filesystem, and preserve the sender's repo-relative
  layout.
- **delivery vs read** — `DeliveryStatus` (transport: created/sent/delivered/
  received) is distinct from `FlowMessage.is_read` (per-recipient read state).
- **roster / role ladder** — `participants` is the hub-authoritative membership
  list; roles rank `owner > full-access > admin > editor > member > reader >
  guest`. Ownership and "who can invite" derive from it, never from `created_by`.

## Related

- [`../session_share_spec.md`](../session_share_spec.md) — Claude Code *session
  transcript* transfer between machines (adjacent, but not conversation collab).
- [`../data-management/record-model.md`](../data-management/record-model.md) and
  [`../record-entity-sync.md`](../record-entity-sync.md) — the record/entity
  index machinery the projection and receive paths build on.
- [`../typeid.md`](../typeid.md) — the `TypeId` grammar used throughout.
