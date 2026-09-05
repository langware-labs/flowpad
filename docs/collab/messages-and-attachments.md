---
id: 8d9a3036-02ce-593b-bafa-a06016a41168
---

# Messages & Attachments

The unit of conversation traffic is the **`FlowMessage`** entity
(`flow_sdk/builtin/flow_message.py:239`). Every chat turn, every shared file, every
forwarded asset, and every pending-invitation placeholder is a `FlowMessage`. This
doc covers its schema, the attachment model, the **body-bundle** lifecycle (how
binary/entity payloads move off the message header onto the hub blob store and
back), and the **delivery** state machine (the receipt ticks). It is the
data-plane companion to `./conversation-model.md` (the conversation that projects
`message_ids`), `./sharing-and-sync.md` (forward provenance + bundle packaging),
and `./hub-fanout-and-loader.md` (who fans which UPDATE, and where receive
materialization runs).

The governing split is **header vs. body**:

- The **header** is the cheap, always-synced part — text, sender, delivery
  status, the attachment list (descriptors only), inline previews. It rides the
  hub message frame and the entity sync.
- The **body** is the expensive part — actual file bytes, serialized entity
  records, or metadata-only git transfer declarations, packed into a `.flowmsg`
  zip and parked on the hub blob store. It is uploaded once by the sender and
  pulled lazily by each receiver.

Almost every invariant below exists to keep the header useful *before* the body
arrives, and to keep local-only state (read/archive/download) from being
clobbered by a hub refresh.

## 1. FlowMessage schema & kinds

`FlowMessage` extends `Entity` and carries the conversational payload plus a
band of receipt/lifecycle state (`flow_sdk/builtin/flow_message.py:239`). The
load-bearing header fields and their defaults are declared around
`flow_sdk/builtin/flow_message.py:262`+: `text` (required), `instruction`,
`attachment` (the descriptor list), `sender_id`/`sender_name`,
`receiver_address`, `conversation_id`, the forward-provenance pair
`cloned_from_id`/`cloned_from_sender_id`, and the lifecycle enums
`delivery_status` (default `CREATED`), `body_status` (default `NA`), and `kind`
(default `USER`).

### Local-only fields (sync invariant)

A hub metadata refresh must never reset state that only *this* machine owns.
`LOCAL_ONLY_FIELDS` (`flow_sdk/builtin/flow_message.py:252`) pins
`body_status`, `is_read`, `is_archived`, `received_at`, `is_draft`, and
`prompt_auto_handled` as local. `body_status` is local because the
download/delivery lifecycle is per-device — resetting it would re-trigger an
already-completed body download. `prompt_auto_handled` is the receiver's
"I already auto-ran this prompt" idempotency marker; the hub never learns of it,
so it must survive every refresh.

`is_stale` (`flow_sdk/builtin/flow_message.py:340`) adds a *touch guard* on top
of last-writer-wins: the hub re-stamps `updated_date` on bare touches (a body
re-materialize, an unchanged re-emit), so a strictly-newer hub clock is
confirmed against an actual content delta — it serializes local vs. merged
candidate (excluding `_STALE_IGNORE_FIELDS`) and treats byte-identical payloads
as **not** stale. This stops a pure touch from dragging the conversation's inbox
recency forward.

### FlowMessageKind

`FlowMessageKind` (`flow_sdk/builtin/flow_message.py:40`) discriminates two kinds:

- **`USER`** — a normal message; the default for everything the user or hub
  produces.
- **`INVITATION`** — a **local-only placeholder** `FlowMessage` that represents a
  pending hub `Invitation` as the first row of a conversation strip. It has no
  hub twin; instead its `context_entities` carry the backing `Invitation` TypeId
  so the UI can read `invitation_id` off it and render the Accept action.

## 2. Attachments

An `Attachment` (`flow_sdk/builtin/flow_message.py:202`) is a small BaseModel: an
`attachment_type` plus a single `data` string whose meaning depends on the type.
`AttachmentType` (`flow_sdk/builtin/flow_message.py:18`) enumerates five:

```
AttachmentType   data is interpreted as                              body?
--------------   ---------------------------------------------       -----
TYPE_ID          "type-id" — ref to a LOCAL entity; pack_bundle      yes
                 serializes it into the bundle's attachment subtree,
                 or records a git transfer declaration in git mode
FILE             path relative to the .flowmsg VFS root              yes
                 (stored at data/<filename>, FILE_VFS_PREFIX)        (:124)
REPO             full repo path; the uuid5 is derived from it        no
URL              a URL                                               no
PROMPT           inline prompt TEXT, or VFS subpath prompt/<file>    inline=no
                 (PROMPT_FILE_VFS_PREFIX, :125)                      file=yes
```

So `data` is overloaded by type: a local entity reference (`TYPE_ID`), a VFS
path under `data/` (`FILE`), a repo path that *derives* its uuid5 (`REPO`), a raw
URL (`URL`), or — for `PROMPT` — either the literal prompt text (inline, no body)
or a `prompt/<filename>` subpath (file-backed, needs body).

Three fields on `Attachment` are about presentation and approval rather than
storage (`flow_sdk/builtin/flow_message.py:233`):

- **`local_path`** — transient, **API-response only**, never stored in the DB. The
  model serializer (`flow_sdk/builtin/flow_message.py:370`) populates it at
  serialization time by resolving the VFS subpath through the message's embedded
  storage, and **only when the bytes are actually on local disk**. The UI reads a
  non-null `local_path` as "this file is downloaded": a receiver sees `null`
  until it pulls the bundle; the sender sees it set the moment the file is staged.
- **`proposer_id` / `approved_by`** — the prompt-approval pair. `proposer_id` is
  who suggested the prompt; `approved_by` is set when the other party approves it.
  Because `approved_by` is nested inside `attachment` it can't be marked
  `LOCAL_ONLY`, so `merge_hub_payload` (`flow_sdk/builtin/flow_message.py:313`)
  re-applies the receiver's locally-approved value (keyed by `data`) over a hub
  copy that lacks one — otherwise a refresh would revert approval and the prompt
  would re-run on every sync.
- **`prompt_preview`** — an inline copy of a prompt-entity `TYPE_ID`'s text that
  rides the **header** so receivers can preview (and execute) the prompt *before*
  pulling the body bundle. NOTE: this field, plus `proposer_id`/`approved_by`,
  must also exist on the hub's mirrored `Attachment` model — the hub silently
  **drops unknown fields** on the round-trip, which would strip the receiver's
  preview.

### Structural self-pointers

Every message carries two structural `TYPE_ID` attachments —
`conversation-<conversation_id>` and `flow_message-<id>` — that wire it into its
conversation. `summary()` (`flow_sdk/builtin/flow_message.py:497`) and
`clone_for_forward` (`flow_sdk/builtin/flow_message.py:516`) both filter these
out when counting/copying user-meaningful attachments.

## 3. Body-bundle lifecycle

A message "has a body" iff at least one attachment needs packed bytes:
`has_body()` (`flow_sdk/builtin/flow_message.py:470`) returns True for `FILE`,
`TYPE_ID`, or a `PROMPT`-with-file; URL / REPO / inline-PROMPT are body-free. The
body itself is a single `.flowmsg` zip named `BODY_FILENAME = "body.flowmsg"`
(`flow_sdk/builtin/flow_message.py:112`), stored on the hub at
`flow_message/<id>/fs/<BODY_FILENAME>`.

`BodyStatus` (`flow_sdk/builtin/flow_message.py:26`) is a three-state lifecycle,
**hub-enforced**:

```
            (text-only / URL / REPO / inline-PROMPT)
        ┌───────────────────────────────────────────────┐
        │                                                │
        ▼                                                │
      ┌────┐                                             │   no body ever needed
      │ NA │  ◄── terminal; never leaves NA              │   → stays NA
      └────┘
                              has_body() == True
                                     │
   hub add_message stamps it ───────▼
   (_attachments_require_body)   ┌───────────┐   sender upload_body() done
                                 │ UPLOADING │ ───────────────────────────┐
   receivers WAIT here ────────► └───────────┘                            │
                                                                          ▼
                                                                     ┌───────┐
   download_body() refuses unless READY ◄──────────────────────────│ READY │
   (BodyNotReadyError)                                               └───────┘

   Transitions enforced hub-side: NA is terminal; UPLOADING → READY only.
```

### Upload (sender)

`upload_body()` (`flow_sdk/builtin/flow_message.py:572`) runs three steps:

```
1. pack_bundle(self, transfer_mode) -> temp .flowmsg zip
2. POST multipart  flow_message/<id>/fs/upload  with BODY_FILENAME
3. action set_body_status { body_status: READY, attachment_filename }
```

The hub FM is already at `UPLOADING` when this runs — the hub's `add_message`
stamps it as the header is created, which always precedes the upload, so no
explicit UPLOADING announce is needed. Two subtleties: (a) the sender holds only
the `member` role on a hub conversation and `flow_message.update` is denied to
`member`, so step 3 **must** go through the `set_body_status` *action*, not a
plain entity PUT — a PUT would 401 and strand the body on UPLOADING; (b) the
action is what **fans the UPDATE to all participants**, a plain PUT would only
notify the sender/owners and leave receivers stuck. On any step failure the
hub-side status stays UPLOADING and the exception propagates for the caller to
retry. An optional `on_progress(done, total)` drives the sender's progress bar.

### Body transfer modes

Transfer mode governs only the **body** axis (how the bytes travel). The **metadata
axis** is separate and transport-independent: every bundle carries `entities.json`, a
`{ "<type>-<id>": <portable entity JSON> }` map produced by `Entity.to_common_json()`
(a model dump minus the sender-local set — scope, project_id, asset_ref, git_origin, …)
for each file-backed/repo attachment and its nested descendants. On receive the
unpacker overlays each envelope onto the materialized row by id, so metadata-only
fields (`parent_type_id`, labels, status, semantic_lock) survive even a bytes-only
`copy` share; the receiver re-derives the stripped placement fields locally. The five
header-serialized DB-record types (conversation, flow_message, claude_session,
flowpad_diagnosis, remote_worker_session) keep their own per-attachment `header.json`
carrier and are excluded from `entities.json`.

The body upload contract has two transfer modes:

- **`copy`** (default) — file-backed TYPE_ID attachments copy their source file or
  folder into the bundle. If the source lives in git, the bundle also records a
  `GitOrigin` so the receiver can preserve repo-relative placement, but the bytes
  still ride inside the `.flowmsg`.
- **`git`** — git-backed attachments are metadata-only on the body axis. The bundle
  carries `fs_origins.json`, `git_transfers.json`, and
  `metadata/<type>-<id>/metadata.json`; it does not carry the git-backed file
  bytes. On receive, the unpacker resolves a matching local checkout, pulls the
  branch when possible, or clones the remote, then indexes the entity from the
  real filesystem location. Existing local entities still use the normal
  collision rule: identical placement is idempotent; conflicting placement
  raises unless the caller retries with overwrite.

For file-backed records such as markdown, skill, workflow, spec, and plan, git
mode means "restore the record from the checkout and sender metadata", not
"copy a file out of the bundle." For graph artifacts, git mode carries only the
artifact declaration and `GitOrigin`; the sender's absolute path is deliberately
cleared on receive and resolved later when the receiver opens the artifact.

Copy-mode file-backed assets carry named capsules with their source bytes:
Markdown identity remains in its comment block and folder identity remains in
`.flow/capsules/identity.json`. Packing and restoring existing sources never
injects, rewrites, or repairs an id; duplicate/conflicting copied identities are
left to the indexer's warn-and-skip rule. Only a source-less rendered fallback
mints its proposed bundle id through `TypeInfo` after the path exists.

### Download (receiver)

`download_body()` (`flow_sdk/builtin/flow_message.py:636`) **refuses with
`BodyNotReadyError`** (`flow_sdk/builtin/flow_message.py:115`) unless
`body_status == READY` — receivers must wait for the hub's body_status UPDATE
first. It then reuses the standard `unpack_bundle` path, so every attachment kind
(FILE, PROMPT-file, TYPE_ID, file-backed records) restores **identically** to the
receive-on-inbox flow; file-backed assets land in the conversation's mapped
project. In git mode this same path performs the git lifecycle first and then
indexes from the checkout; there is no bundle-to-project copy phase for the
git-backed bytes. It propagates `FlowMessageExistsError` (collision; re-invoke with
`overwrite=True`) and `FlowMessageNoProjectError` (no mapped project) so the
explicit download path can prompt — unlike the implicit sync callers, which
log-and-drop.

## 4. Delivery state machine

`DeliveryStatus` (`flow_sdk/builtin/flow_message.py:54`) is a single source of
truth imported by **both** the client and the hub. It is monotonic:

```
   PENDING_SEND        CREATED  ──►  SENT  ──►  DELIVERED  ──►  RECEIVED
   (queued, no          🕐         ✓          ✓✓             ✓✓ blue
    hub attempt)      Pending    on hub    recipient       recipient
        │                        store      pulled it        read it
        └──► any real hub status advances over it
             (rank max'd to 0; never downgrades a sent msg)

   DELIVERY_ORDER = (CREATED, SENT, DELIVERED, RECEIVED)   index == rank
   PENDING_SEND is DELIBERATELY NOT in DELIVERY_ORDER.
   The hub never stores PENDING_SEND or CREATED — both are client-local
   pre-accept states.
```

`DELIVERY_ORDER` / `_RANK` (`flow_sdk/builtin/flow_message.py:79`) give O(1) rank
lookup; because `DeliveryStatus` is a str-Enum, one key serves both enum and raw
string callers. `delivery_advances(current, incoming)`
(`flow_sdk/builtin/flow_message.py:97`) enforces monotonicity: an unknown
`incoming` is rejected, and `incoming` must rank `>=` `current` (unknown/None
`current` is treated as CREATED, rank 0). `PENDING_SEND` ranks `-1`, so any real
status advances over it and it can never *downgrade* a message that already
reached the hub.

### Who sets each transition

```
CREATED    local create        (model default; hub never stores it)
SENT       hub on accept/persist (stamped on add_message, returned in the ACK)
DELIVERED  recipient client pulled it  -> auto-ack mark_delivered
RECEIVED   recipient READ it    -> mark_received, shared through auto-watch
```

The receiver's bridge auto-acks delivery on inbound CREATE: it fires the
`mark_delivered` action from `HubWsBridge._handle_flow_message_op` — skipping
when the local user is the sender — which is the only signal that ticks the
sender's UI from ✓ to ✓✓. Read receipts go through
`HubWsBridge.mark_received`; the hub fans the resulting UPDATE through
role-based auto-watch so accessible copies tick to ✓✓ blue.

Both recipient acknowledgements are gated by the reporting installation's
`preferences.notifications.share_message_status` preference. Disabling it
does not hide receipt data other participants already shared and does not
affect the sender's initial `SENT` acknowledgement.

### Inbound monotonicity guard

The hub propagates status changes as `update` ops. The bridge's update handler
(`flow_sdk/cloud_client/hub_bridge.py:564`) copies a fixed allow-list of fields
onto the existing row, but **guards `delivery_status`**: it applies the new value
only if `delivery_advances(existing, incoming)` holds
(`flow_sdk/cloud_client/hub_bridge.py:587`). This is what drops out-of-order or
stale frames — e.g. a `body_status` UPDATE that carries a piggybacked stale
`created`, or a reordered frame, must not knock `sent`/`delivered` backward. The
same handler watches the `body_status` transition to READY and eagerly pulls the
bundle (`_maybe_eager_pull_bundle`), **skipping when we are the sender** (the
sender's bundle is already on disk).

## 5. Materialization probes

Two probes answer "is the body actually here yet?", gating the UI between a
single **Download** button and rendered attachment chips.

### Per-attachment: `_type_id_record_materialized`

`_type_id_record_materialized(data)` (`flow_sdk/builtin/flow_message.py:164`) is a
**sync disk probe** — disk is the source of truth. For a `TYPE_ID` attachment it
checks for a materialized record folder
(`<records_root>/<type>/<id>/metadata.json`). Two carve-outs:

- **Structural / row-only types always count as present**
  (`_NON_MATERIALIZING_TYPE_IDS`, `flow_sdk/builtin/flow_message.py:149`):
  `conversation`, `flow_message`, `task`, `claude_session`. These never create
  a standard records folder — `conversation`/`flow_message` are transport,
  `claude_session` is a `receive_policy='auto'` row-only payload installed at
  unpack, and `task` materializes a slim row (its *chip* state still follows
  the MessageAttachment, see §6) — so gating on a folder would strand the
  message behind Download forever. Git provenance is carried as `GitOrigin`
  bundle metadata, not as a `TYPE_ID` attachment.
- **Body-bearing types additionally require their source file**
  (`_BODY_BEARING_TYPE_IDS = {spec, markdown, plan}`,
  `flow_sdk/builtin/flow_message.py:161`): a record folder with only
  `metadata.json` and no resolvable `asset_ref` is a content-less **stub** (e.g. a
  spec row minted from a body-less hub reflect ahead of its bundle). A stub must
  NOT count as downloaded, or the bundle carrying the real body is never re-pulled
  and the entity renders blank.

### Per-message: download completion and missing assets

`FlowMessage._body_download_state()` owns the local availability checks for
both API serialization and `is_body_downloaded()` (used by catch-up).
Its transient fields are never persisted or accepted from the hub:

- `body_downloaded`: the message has a body and either its bundle is unpacked
  locally or all renderable attachments are already available locally.
- `body_unpacked`: the extracted staging tree contains `flow_message.json` or
  the legacy `header.json` envelope. A raw ZIP alone is insufficient.
- `body_missing_attachments`: references (`attachment_type`, `data`) whose
  content is unavailable locally. FILE and PROMPT-file attachments need actual
  bytes; TYPE_ID attachments use `_type_id_attachment_present` to check staged
  or materialized content. Structural references do not count as missing.

A downloaded bundle with missing assets is a **partial download**. The transcript
shows “Downloaded” with a warning icon whose tooltip lists the missing references
and offers **Download again**. Download errors also offer that action. It calls
the existing `download_body` action, fetching and unpacking a fresh hub bundle
even when the message is already downloaded. The warning stays if the new bundle
still lacks assets; a successful retry clears the previous download error.
Available assets remain usable; missing assets have no Open action. The context
panel uses the same state. Catch-up does not repeatedly fetch an already unpacked
bundle just because its sender omitted assets. Before download, unavailable
references are pending and do not show a missing-assets warning.

Unpacking a body into an existing message in the same conversation is idempotent,
including header-only bundles. Standalone imports and mismatched parents retain
the existing overwrite conflict protection.

## 6. Reception phase model

The receive pipeline for a message's **payload** is one five-phase flow; every
attachment kind rides it, differing only in *who* pulls the trigger at each
gate:

```
Phase 1  RECEIVED    header + conversation rows indexed (pre-body).
                     → download: automatic for asset-entity TYPE_ID messages
                       (_maybe_eager_pull_bundle on body_status READY, retried
                       by notification_scanner); manual Download otherwise.
Phase 2  DOWNLOADED  bundle in the FM's staging (download/ + unpacked/); every
                     payload entry has a MessageAttachment row. Unbound
                     conversations leave copy-mode entries at scope=None;
                     bound conversations proceed directly to installation.
Phase 3  REVIEWED    dashed chip → AssetReviewDialog (content + source:
                     embedded / git / cloud). receive_policy='auto' types
                     WAIVE this gate — see below.
Phase 4  INSTALLED   the ONE install action: copy/clone + reindex with the
                     chosen scope/project stamped (or row materialization for
                     row-only types). project_id=null ⇒ scope inherits live
                     from the parent conversation (Entity.effective_project_id).
Phase 5  SETUP/OPEN  TypeInfo.setup_skill spawns the Vibe setup session;
                     solid chip opens the entity (or the review modal, for
                     installable types where uninstall lives).
```

**Transport vs payload.** The conversation row, its inner flow_messages,
`conversation.jsonl`, and `remote_worker_session` snapshots are TRANSPORT —
the message plumbing itself — and always materialize at unpack; they are not
reviewable attachments. Everything else is PAYLOAD and stages.

**Conversation project binding is durable install consent.** Selecting a
project for an attachment binds the conversation to that project, fans the
choice out to every existing staged copy-mode attachment, and auto-installs
future copy-mode arrivals there. An unbound conversation keeps those
attachments staged for review and explicit installation. Git transfers are
repository-determined rather than copied into the selected project, so the
fan-out skips them.

**`TypeInfo.receive_policy`.** The per-type gate declaration:
`None` (default) ⇒ an unbound conversation follows staged → review → explicit
install — the consent boundary for anything agent-executable or byte-copying;
a bound conversation uses its durable project consent. `"auto"` ⇒ row-only
passive payload (claude_session transcripts, flowpad_diagnosis): unpack stages
the MA and installs it immediately through the same action — no review dialog,
chip navigates directly, and `receive_row_overrides` stamp local state (e.g.
`received=True`). Auto-policy entries install into the bound project when one
is present; otherwise they install at user scope and inherit effective project
context through the parent chain.

Coverage: `tests/unit/test_receive_policy_auto_install.py` (pipeline contract),
`tests/unit/test_conversation_project_binding.py` (project fan-out and future
arrival auto-install),
`ui/tests/unit/staged-chip-state.test.ts` (chip truth table incl. task), and
`ui/tests/hub/transcript_share_two_client.test.ts` (live two-instance e2e over
the hub: share → accept → download → auto-installed MA + received row).

## Invariants (summary)

- **Header is useful before the body.** `prompt_preview` and `local_path=null`
  let the UI render and even execute a prompt pre-download; `body_downloaded`
  gates the rest behind one Download button.
- **Local state survives hub refresh.** `body_status`, read/archive,
  `prompt_auto_handled`, and (via `merge_hub_payload`) attachment `approved_by`
  are never reverted by a sync.
- **Status is monotonic, both directions.** `delivery_advances` guards the
  inbound bridge; the hub enforces `UPLOADING → READY` and never stores
  `PENDING_SEND`/`CREATED`.
- **Disk is the source of truth** for "is it downloaded?" — both probes read the
  filesystem, never trust a flag in isolation.
- **Git mode still materializes from disk.** The transferred declaration is only
  enough to locate the source; the entity row and FTS entry are rebuilt from the
  receiver's checkout.

See `./hub-fanout-and-loader.md` for the fan-out mechanics behind the
`set_body_status` and `mark_received` UPDATEs, `./sharing-and-sync.md` for
`clone_for_forward` provenance and bundle packaging, and
`./conversation-model.md` for how `message_ids` projects these rows into an inbox.
