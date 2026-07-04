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
- The **body** is the expensive part — actual file bytes and serialized entity
  records, packed into a `.flowmsg` zip and parked on the hub blob store. It is
  uploaded once by the sender and pulled lazily by each receiver.

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
                 serializes it into the bundle's attachment subtree
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
1. pack_bundle(self)  ->  temp .flowmsg zip          (to_file, :457)
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

### Download (receiver)

`download_body()` (`flow_sdk/builtin/flow_message.py:636`) **refuses with
`BodyNotReadyError`** (`flow_sdk/builtin/flow_message.py:115`) unless
`body_status == READY` — receivers must wait for the hub's body_status UPDATE
first. It then reuses the standard `unpack_bundle` path, so every attachment kind
(FILE, PROMPT-file, TYPE_ID, file-backed records) restores **identically** to the
receive-on-inbox flow; file-backed assets land in the conversation's mapped
project. It propagates `FlowMessageExistsError` (collision; re-invoke with
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
RECEIVED   recipient READ it    -> mark_received, fanned to ALL participants
```

The receiver's bridge auto-acks delivery on inbound CREATE: it fires the
`mark_delivered` action (`flow_sdk/cloud_client/hub_bridge.py:559`) — skipping
when the local user is the sender — which is the only signal that ticks the
sender's UI from ✓ to ✓✓. The read receipt goes through the `mark_received`
action (`flow_sdk/cloud_client/hub_bridge.py:829`); the hub fans the resulting
UPDATE to every participant so all copies tick to ✓✓ blue.

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
(`<records_root>/<type>/<type>-@<id>/metadata.json`). Two carve-outs:

- **Structural / row-only types always count as present**
  (`_NON_MATERIALIZING_TYPE_IDS`, `flow_sdk/builtin/flow_message.py:149`):
  `conversation`, `flow_message`, `task`, `claude_session`. These never create
  a standard records folder (conversation plumbing, or an indexer/row-only
  unpack), so gating on a folder would strand the message behind Download
  forever. Git provenance is carried as `GitOrigin` bundle metadata, not as a
  `TYPE_ID` attachment.
- **Body-bearing types additionally require their source file**
  (`_BODY_BEARING_TYPE_IDS = {spec, markdown, plan}`,
  `flow_sdk/builtin/flow_message.py:161`): a record folder with only
  `metadata.json` and no resolvable `asset_ref` is a content-less **stub** (e.g. a
  spec row minted from a body-less hub reflect ahead of its bundle). A stub must
  NOT count as downloaded, or the bundle carrying the real body is never re-pulled
  and the entity renders blank.

### Per-message: `_compute_body_downloaded`

`_compute_body_downloaded(atts)` (`flow_sdk/builtin/flow_message.py:408`) is the
message-level flag the serializer emits as `body_downloaded`
(`flow_sdk/builtin/flow_message.py:405`). It returns False if there is no body,
else True iff **every** renderable body attachment is on disk: FILE and
PROMPT-file attachments need a resolved `local_path`; TYPE_ID attachments must
pass `_type_id_record_materialized`. The UI switches the **whole message** between
Download and chips off this one flag, so the transcript and the context panel
share state.

`is_body_downloaded()` (`flow_sdk/builtin/flow_message.py:426`) is the disk-probe
twin for backend callers (e.g. the catch-up loop deciding whether to re-pull a
bundle) that need the same signal without paying for a full `model_dump` — keep
the two in sync.

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

See `./hub-fanout-and-loader.md` for the fan-out mechanics behind the
`set_body_status` and `mark_received` UPDATEs, `./sharing-and-sync.md` for
`clone_for_forward` provenance and bundle packaging, and
`./conversation-model.md` for how `message_ids` projects these rows into an inbox.
