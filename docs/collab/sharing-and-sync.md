---
id: 6dc59b48-b09d-5a34-b525-08b095a00ff5
---

# Sharing & Sync

How "share this" works in Flowpad — from the single dialog that every surface
opens, through the three backend handlers that all converge on one
shared-context-merge-and-dispatch tail, to the hub-invite sequence
`Conversation.share()` runs, and finally why a comment under a shared document
auto-shares with no "share comments" code anywhere.

The recurring theme is **funnels**: many entry points, one prepared payload, one
dispatch tail, one access edge. Each funnel is named below; cross-cutting detail
lives in the sibling docs linked at the end.

---

## 1. Frontend — one dialog, many surfaces

There is exactly one share UI:
`ui/src/components/share-to-conversation/ShareToConversationDialog.tsx`
(component `~82-291`). Markdown, whiteboards, agentic-process sessions, raw
files, a message forward, a task/plan/ask-help — all open *this* dialog. They
differ only in the `ShareSource` they hand it.

### The `ShareSource` funnel

`ui/src/hooks/share-sources.ts:49-63` defines the interface. The load-bearing
member is `prepare(opts)`, which yields a `SharePrepPayload`
(`share-sources.ts:24-32`):

```
SharePrepPayload {
  assetReferences:       string[]   // serialized TypeIds → TYPE_ID attachments (the chip)
  sharedContextEntities: string[]   // serialized TypeIds → shared context on FM + conversation
  files?:                File[]     // raw bytes riding the body bundle
}
```

A `ShareSource` **never mints an entity and never creates a Conversation** — the
header comment (`share-sources.ts:1-15`) calls this out explicitly. It only
describes what to attach. Conversation selection/creation is owned by the dialog.
That separation is what killed the duplicate-conversation bug: prep runs once,
the conversation is chosen (existing) or created (once) elsewhere.

`prepare` is wrapped in `resolveOnce` (`share-sources.ts:65-75`): the first call
caches its `SharePrepPayload`, so a click → error → retry reuses the same payload
instead of re-resolving (re-downloading a file, re-indexing a transcript).

The ~7 sources, each a thin factory:

| Source (`share-sources.ts`) | What it attaches |
| --- | --- |
| `genericEntityShareSource` (`81-97`) | a doc/entity (markdown, whiteboard) as **one** TYPE_ID ref + the same ref as shared context. No fork, no Task. |
| `agenticProcessShareSource` (`108-143`) | the session's `claude_session` transcript as the chip; shared context = `[transcript, process]` so backend mutual-linking joins process ↔ message. Optionally attaches the raw `.jsonl` (`isProcess` → transcript toggle). |
| `fileShareSource` (`150-172`) | **raw bytes, no entity** — downloads via `fsManager`, rides as a FILE in the body bundle (same path as a pasted screenshot). `assetReferences`/`sharedContextEntities` are empty. |
| `messageForwardShareSource` (`195-197`) | nothing — a `noAssetShareSource` (`179-188`) that only labels the share; the backend `forward` action owns packaging. Committed via the dialog's `commit` override. |
| task / plan / ask-help | (sibling sources) task/plan ride as entity refs; ask-help has no entity, so `requiresTitle` forces the user to type a title. |

### Dialog flow

```
open dialog (source)
  │  guardCloudAction('share')  ── Local/private mode → close, no cloud  (~142-147)
  ▼
pick contacts  ── ContactPicker + AddressBook → participants[]          (~298-313)
  │
  ▼
useConversationsForContacts(participants, projectId, open)               (~117)
  │  load conversations you ALREADY have with every chosen contact
  ▼
select an existing row   OR   "Start new conversation"                   (~370-416)
  │  default selection = latest existing conv, else NEW_CONVERSATION     (~126-129)
  ▼
doShare(existingId|null)                                                 (~182-238)
  │  1. if remote → ensureCloudLogin gate
  │  2. payload = await source.prepare({recipientEmails,title,files,…})  (cached)
  │  3. build SendTarget:
  │       existing → {kind:'existing', conversationId}
  │       new      → {kind:'new', params:{participants,title,shared_context_entities,…}}
  │  4. commit(target,payload)   (forward override)   OR   send(target,payload)
  ▼
success screen → onShared(convId) → "Open message"
```

**Invariant (the de-dup fix):** the *first* contact yields one conversation +
one invite; a later share to the same people **threads into the existing
conversation** with no new invite/email. Selecting an existing row routes to the
"existing" send target (the backend's `add_message` path) instead of minting a
new conversation. See `./conversation-model.md` for `shared_context_entities`
and `resolve_project_id`; the new-vs-existing send split lives in
`use-send-to-conversation`.

---

## 2. Backend — three paths, one dispatch tail

Every share, reply, and forward is one of **three** handlers, and all three
converge on the same merge-context + dispatch tail. The convergence is the
point: context is merged identically, and the conversation.jsonl / hub-header /
body-upload work happens in exactly one function.

```
                         ┌───────────────────────────────────────────┐
 NEW conversation        │  share_action.share_entity()              │
 (first share)           │  flow_sdk/app/actions/share_action.py     │
                         │  :43-113                                  │
                         │    → Conversation.share(recipients)       │
                         │    → persist remote=True on local row     │
                         └───────────────────────────────────────────┘
                                          (hub-invite sequence → §3)

                         ┌───────────────────────────────────────────┐
 EXISTING conversation   │  handle_add_message()                     │
 (reply / re-share)      │  notification_action.py :677-868          │
                         └───────────────────────────────────────────┘
                                          │
 FORWARD                 ┌───────────────────────────────────────────┐
 (clone into another)    │  handle_forward_message()                 │
                         │  notification_action.py :905-979          │
                         │    → src_fm.clone_for_forward(…)          │
                         │    → _copy_clone_storage(…)               │
                         └───────────────────────────────────────────┘
                                          │
   both reply & forward ──────────────────┤
                                          ▼
                  _merge_shared_context_into_conversation()  :356-375
                                          ▼
                  _finalize_message_dispatch()               :504-534
                  (link · jsonl append · hub header · body upload)
```

### Path A — NEW: `share_action.share_entity()` (`share_action.py:43-113`)

The generic `share` action (`types="all"`). It reconstructs the entity in-process
(no DB save) from the request body, sanitized to API fields (`:68-70`). If the
body carries `recipients` **and** the entity is a `Conversation`, it calls
`Conversation.share(recipients=…)` (`:79-80`) — the hub-invite sequence in §3 —
and feeds participants+recipients to the address-book learner. Otherwise plain
`entity.share()` (`:91`).

After `share()` returns it re-loads the on-disk row and persists `remote=True`
(`:98-112`). This matters because `share()` operated on a transient
request-built instance, while `handle_add_message`'s `is_remote_send` gate later
reads `remote` off the **persisted** row. The `_local_mode_share_blocked()` gate
(`:31-40, :51`) is the backend belt-and-suspenders behind the FE
`guardCloudAction`.

### Path B — EXISTING (reply): `handle_add_message()` (`notification_action.py:677-868`)

The single message-send handler — text, files, images, prompts, asset refs all
come through here. The share-relevant arc:

1. Parse `asset_references` + `shared_context_entities` (both legacy
   `context_entities` and the new key are accepted, `:707-719`).
2. `_parse_context_typeids` strips the transport types (`conversation`/
   `flow_message`) and the conversation's own id (`:749`).
3. `_merge_shared_context_into_conversation(conv, typeids, someone)`
   (`:356-375`) — **idempotent**: `add_shared_context_entities` dedups by
   `(type, id)`, saves only when changed, then calls
   `_link_context_to_conversation(typeids)` to set each item's
   `parent_type_id` back to the conversation (the parent-link that powers
   recursive share, §4). The local backend is the single writer of the local
   Conversation's `shared_context_entities` — there is **no** optimistic FE
   write of this field.
4. Build the reply `FlowMessage`, attach files/asset-refs/prompt
   (`:820-837`), set `is_remote_send` from `conv.remote` (`:842-844`), save.
5. `_finalize_message_dispatch(...)` (the shared tail below).

### Path C — FORWARD: `handle_forward_message()` (`notification_action.py:905-979`)

Triggered by `share_action.flow_message_forward` (`share_action.py:167-203`).
It clones rather than re-attaches:

- `clone_for_forward(...)` (`flow_message.py:516-570`) builds a **new** entity:
  fresh id via `allocate_id` → `mint_uuid` (`:558`), fresh timestamps and
  delivery/read/body state (model defaults), the forwarder as `sender_id`,
  provenance `cloned_from_id` + `cloned_from_sender_id` (`:555-556`). It
  **drops the per-message transport attachments** (`conversation-<src>` /
  `flow_message-<src>`, the `drop` set at `:535-538`), **deep-copies** content
  attachments (`:539-543`), and **rewrites** the shared context to the target
  conversation (`:550`, `:559-569`).
- `_copy_clone_storage(src, clone)` (`:871-902`) byte-copies FILE/PROMPT-file
  bytes between embedded storages (keyed by entity id, so the new id's subpaths
  resolve). Missing source bytes are skipped — the bundle re-pulls from the hub.
- Then the **same** merge + dispatch tail as a reply (`:961, :970-972`).

### The shared tail: `_finalize_message_dispatch()` (`:504-534`)

The part that must stay in lock-step between reply and forward — they differ
only in how the FM was built:

```
_finalize_message_dispatch(conv, fm, context_typeids, someone, is_remote_send):
  1. _link_message_into_context_entities(fm, …)   # mutual link: each ctx entity → this msg   (:519)
  2. conv = _append_message_to_conversation(…)     # conversation.jsonl pointer + message_ids/count (:522)
  3. _notify_ui_conversation_updated(…)            # refresh sender UI immediately            (:528)
  4. if is_remote_send:                            # hub-mirrored only                        (:529)
       _send_conversation_message_header(conv,fm)  #   create hub header (delivery receipts)
       if fm.body_status == UPLOADING:
         create_task(_upload_body_and_finalize(…)) #   body bundle uploads in background       (:533)
```

See `./messages-and-attachments.md` for attachments, body upload, and clone
internals; `./hub-fanout-and-loader.md` for what the hub header triggers on the
receive side.

---

## 3. `Conversation.share()` — the hub-invite sequence

`flow_sdk/builtin/conversation.py:186-265`. Without `recipients` it is just
`Entity.share()` (POST `/graph/conversation`, caller becomes `owner`). With
`recipients` it runs the full invite sequence:

```
1. await super().share()                         (:209)
   POST /graph/conversation → hub-side row exists; conversation becomes REMOTE,
   caller gets the `owner` role.

2. _link_context_to_conversation()               (:213 → :267-309)
   For each shared-context doc, set parent_type_id = this conversation locally.
   The hub does NOT host doc types (markdown …), so the doc itself is never
   pushed; instead the REMOTE conversation becomes its parent → the doc is now
   `effective_remote` (powers §4).

3. _deliver_pending_messages()                   (:228)
   Flush any messages composed while the conversation was still local-only
   (e.g. the offline flow-diagnose artifact). Reuses the SAME send pipeline a
   reply uses — no separate push path — and runs BEFORE inviting so the
   invitation's callback and the recipient's first fetch resolve.

4. callback_override = _first_message_landing_path()   (:235 → :396)
   Post-accept landing → the conversation's first FlowMessage on the hub (that
   URL renders MessageLanding with the "Open in Flowpad" button). Computed once;
   same for every recipient. None when there are no messages yet.

5. asset_targets = _share_hostable_assets()      (:243 → :311-351)
   For each shared-context asset whose TYPE the hub hosts
   (_HUB_SHAREABLE_ASSET_TYPES = skill, agent — conversation.py:76), push it
   via Entity.share() when not already remote (hub auto-mints
   sharer ─[owner]→ asset), persist remote=True, and collect one `reader`
   invitation_target per asset. Doc types are skipped — they keep riding the
   message bundle.

6. POST /graph/conversation/<id>/join           (:247)
   The caller joins so the creator enters `participants`.

7. for each recipient:  POST /graph/conversation/<id>/members   (:249-264)
   MembershipRequest {
     recipient_email,
     invitation_targets: [
       {typeid: conversation-<id>, role: "member"},   # the conversation channel
       *asset_targets,                                 # one `reader` per hosted asset
     ],
     callback_override,                                # → first-message landing
   }
```

**Invariant — access outlives the channel.** The per-asset `reader` edges ride
the *same* invitation as the conversation `member` grant, but on accept they
become **direct, durable** role edges on the asset itself. So a recipient keeps
access to a shared skill/agent even after leaving or deleting the conversation
— the conversation is the channel, not the access (`:237-242`).

The recipient side — `invitation/pending` → `members/accept` →
`conversation/<id>/join` — is wired in
`flow_message_action.handle_invitation_accept`; see
`./invites-members-identity.md` for members/invite/join and role resolution.
Note `share()` does **not** persist `remote=True` locally; that is the caller's
job (`share_action.share_entity`, §2 Path A) — see the docstring at `:202-204`.

---

## 4. Recursive share — the `effective_remote` chain

There is no "share the comments" code. A comment under a shared markdown
auto-shares because of a parent-link chain established in steps §3.2 / §2.B-3:

```
conversation   (remote = True, hub-hosted)
     ▲ parent_type_id
   doc          (markdown; effective_remote = True because its parent is remote)
     ▲ parent_type_id
   comment      (created under the doc → inherits effective_remote)
```

The mechanism:

- The hub does **not** host doc types, so the markdown is never a hub node. But
  `_link_context_to_conversation` (`conversation.py:267-309`) sets the doc's
  `parent_type_id` to the (remote) conversation. A non-remote entity whose
  nearest hub-known ancestor is remote is **`effective_remote`**.
- When a child is created under that doc — a comment — it inherits
  `effective_remote` and auto-shares under the **nearest hub-known ancestor**,
  which is the conversation. No call site says "also share this comment"; the
  generic create-under-a-shared-parent path handles it.

This is why the parent-link is set on *both* the new-conversation path
(`share()` → full `shared_context_entities`) and the existing-conversation path
(`_merge_shared_context_into_conversation` → just the items shared in that
message): every shared doc must become a parent so its future children fan out.
`refs` on `_link_context_to_conversation` (`:267, :277-281`) is what lets the
reply path link only the subset just shared.

See `./hub-fanout-and-loader.md` for how an `effective_remote` child's create is
dispatched to the hub and received by the other members.

---

## Invariants at a glance

- **One dialog, one prep.** Every surface produces a `ShareSource`; `prepare()`
  runs once (cached) and never creates a conversation or mints an entity.
- **Three handlers, one tail.** New / reply / forward all converge on
  `_merge_shared_context_into_conversation` + `_finalize_message_dispatch`.
- **`remote` is the load-bearing signal.** `is_remote_send` reads it off the
  persisted row; the share action is responsible for persisting `remote=True`.
- **Context merge is idempotent.** Re-sharing the same item is a `(type, id)`
  no-op — no duplicate context, no duplicate invite.
- **Access ≠ channel.** Per-asset `reader` edges are direct and durable; the
  conversation membership is just the delivery channel.
- **Recursive share is emergent.** `parent_type_id` → `effective_remote` makes
  children of shared docs fan out with zero bespoke code.
