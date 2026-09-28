---
id: 9bbe661c-674d-489b-b16f-2172329b02a5
---
<!-- TEMPORARY working doc (untracked). Proposed 2026-09-27, NOT approved. When approved, the still-true parts move
     into docs/data-management/source-contract-boundary.md and the snippets into docs/snippets/message-channels.md,
     each pinned by a test that runs it as written. -->

# Message channels: files, quote-replies, reactions (the generic specification)

Three capabilities any message channel can have. A channel that lacks one says so in data, and every surface
(SDK, CLI, UI, the agent loop) reads that data. No surface branches on a provider's name.

1. **Files.** Send and receive images, video, audio, voice notes, documents and stickers.
2. **Quote-reply.** Answer one specific message, the way WhatsApp and Telegram do.
3. **Reactions.** An emoji on a message, in both directions.

## 1. Where we are (audit, 2026-09-27)

| driver | files in | files out | quote in | quote out | reactions in | reactions out |
|---|---|---|---|---|---|---|
| whatsapp (Cloud API) | ❌ media dropped (`source.py:194`) | ❌ refused (`:340`) | ✅ `context.id` | ✅ `context.message_id` | ❌ dropped | ❌ |
| waha | ❌ caption kept as text, `hasMedia` ignored | ❌ refused (`:395`) | ✅ `replyTo.id` | ✅ `reply_to` | ❌ no `message.reaction` subscription | ❌ |
| telegram | ❌ caption only | ❌ refused | ✅ `reply_to_message` | ✅ (deprecated `reply_to_message_id`) | ❌ no `allowed_updates` | ❌ |
| slack | ❌ `files[]` only in `raw` | ❌ | n/a (threads only) | ⚠️ thread only, by design | ❌ in `raw` | ❌ |
| teams | ❌ | ❌ | ⚠️ `replyToId` = thread root | ⚠️ thread only | ❌ | ❌ |
| gmail / cloud_email | ❌ MIME parts ignored | ❌ | ✅ `In-Reply-To` | ✅ `In-Reply-To` + `References` | n/a | n/a |
| agentmail | ❌ | ❌ | ❌ not mapped | ✅ `/reply` | n/a | n/a |
| helpdesk / http_chat / agent / voice | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

What already exists and is kept:
- `MessageData.attachments: tuple[FileItem, ...]` for inbound, and `in_reply_to` for inbound and outbound.
- `MessageSpec.attachments` and `MessageSpec.reply_to_external_id` for outbound.
- `FlowMessage.reply_to_id`, which projection already fills.
- `ChannelSpec.accepts_attachments`.

Where it breaks today:
- **Files are cut off at three layers.** `DataSource.send` raises `NotImplementedError`. `DriverRuntime.send(...)` has
  no files parameter. Every driver's `_check_outgoing` refuses files (and conformance requires it to).
- **No messaging driver can fetch bytes.** Only gdrive and gcs implement `ByteStore.open`.
- **Quotes are invisible to people.** No UI surface reads `reply_to_id`. The CLI, the composer and `Conversation.send`
  cannot choose which message to answer; they always quote the newest message someone else wrote.
- **Reactions do not exist** at any layer. `EmojiPicker` only types emoji into the composer.

## 2. Provider facts that shape the design

| | files out | per message | files in | quote | reactions |
|---|---|---|---|---|---|
| WhatsApp Cloud | upload → id, or link | **1** (fan out) | media id → URL that **dies in 5 min**, needs Bearer; ids last 7 d | `context.message_id` | 1 per person, replaces; `""` removes; 24 h window |
| WAHA ≥ 2026.6.1 (ours: image 2026-09-01) | `sendImage/File/Voice/Video` url\|base64; voice must be OGG/Opus (`convert:true`) | **1** | `media.url` on WAHA, **file deleted after 180 s**, `X-Api-Key` | `reply_to` serialized id | `PUT /api/reaction`, `""` removes; event `message.reaction` |
| Telegram | upload / URL / `file_id`; photo 10 MB, else 50 MB | 1, or album of 2–10 | `getFile`, link ≥ 1 h, **bot cap 20 MB** | `reply_parameters` (+ partial quote) | bot: **1**, from a **73-emoji list**; inbound needs admin + `allowed_updates` |
| Slack | 3-step external upload | many | `url_private`, Bearer, no expiry | **none**: threads only | many per person; by **name** (`thumbsup`), custom emoji |
| Teams (Graph, app perms) | consent card / SharePoint | many | `downloadUrl` | quote via Bot SDK only | Graph `setReaction` is delegated-only → **not reachable by our driver** |
| Gmail / AgentMail | MIME / base64 ≤ 6 MB or URL | many | attachment id, auth / signed URL | `In-Reply-To` (+ threadId) | none |

These facts force four rules:
1. **Inbound bytes must be copied when the message arrives.** WAHA deletes a file after 180 s, and WhatsApp's download
   link dies after 5 minutes.
2. **The generic layer fans out.** WhatsApp and WAHA carry one file per message.
3. **Emoji are unicode at the contract.** Each driver translates to its own form: Slack names, Teams ids, Telegram's
   allowed list.
4. **A reaction is a change of state, not a message.**

## 3. The contract (`flow_sdk/sources/`)

### 3.1 Traits: declared per class on `MessageSource`

This follows the family's own convention: a trait is a fact about a channel (`echoes_sends`), while a verb is a
protocol found by `isinstance`.

```python
class FileKind(StrEnum):
    IMAGE = "image"; VIDEO = "video"; AUDIO = "audio"; VOICE = "voice"; DOCUMENT = "document"; STICKER = "sticker"

class FileSupport(DataSpec):                      # spec_kind "message.file_support", frozen
    kinds: frozenset[FileKind] = frozenset()      # empty = the channel sends no files
    per_message: int = 1                          # 1 = the runtime fans out, one file per provider message
    max_bytes: dict[FileKind, int] = {}           # a missing kind means no limit we know of
    caption_max: int = 0                          # 0 = no per-file caption; the body goes out as its own message

class MessageSource(RecordSource):
    files: ClassVar[FileSupport] = FileSupport()  # what send() accepts
    quotes: ClassVar[bool] = False                # reply(origin) quotes THAT message; False = it lands in its thread
    reactions_per_actor: ClassVar[int] = 0        # 1 = a new reaction replaces (WhatsApp, Telegram bot); 0 = many
```

### 3.2 Verbs: new protocols in `protocols.py`

```python
@runtime_checkable
class Openable(Protocol):
    """Read the bytes of an item the source handed out (an inbound attachment). ByteStore = Openable + write + delete."""
    def open(self, file: FileItem, *, chunk_size: int = ...) -> AbstractAsyncContextManager[AsyncIterator[bytes]]: ...

@runtime_checkable
class Reacting(Protocol):
    """Put or take back our emoji on a message. `emoji` is unicode; the driver translates, and refuses one the channel
    cannot show (Telegram's list, a Slack name with no mapping) with a SourceError. It never substitutes another."""
    async def react(self, target: CloudOrigin, emoji: str) -> None: ...
    async def unreact(self, target: CloudOrigin, emoji: str = "") -> None: ...  # "" = all of ours
```

`CAPABILITIES` gains `"openable"` and `"reacting"`. `ByteStore` is redefined as `Openable` plus `write` and
`delete`; gdrive and gcs are unchanged.

### 3.3 Values: `values/items.py`

```python
class MessageFileData(FileData):                  # spec_kind "ingest.file.message": a file that rides a message
    as_: FileKind = FileKind.DOCUMENT             # how it is shown: a voice note is not an audio file
    caption: Optional[str] = None
    sha256: Optional[str] = None                  # when the provider reports one (WhatsApp)

class ReactionMode(StrEnum):
    SET = "set"          # emojis IS this person's whole set on the target now (WhatsApp, WAHA, Telegram); () = removed
    ADD = "add"          # Slack reaction_added, Teams reactionsAdded
    REMOVE = "remove"

class ReactionData(Payload):                      # spec_kind "ingest.message.reaction"
    target: CloudOrigin                           # the message reacted to
    sender: UserProfile
    emojis: tuple[str, ...]                       # unicode; an unmapped custom emoji travels as ":name:"
    mode: ReactionMode
    sent_at: Optional[AwareDatetime] = None

class ReactionItem(SourceItemSpec):
    data: Tagged[ReactionData]
```

Why `SET` and not deltas only: a WhatsApp removal arrives with no emoji. Only the application knows which emoji the
removal took away, so the driver reports "their set is now ()" and the application computes the difference.

- **Inbound.** `MessageData.attachments` carries `FileItem`s whose `data` is a `MessageFileData`. The `origin.key` is
  the provider's media handle. `fetch` and `webhook` yield `ReactionItem`s beside `MessageItem`s.
- **Outbound.** A `FileItem` in `MessageData.attachments` has `origin.kind == "local"`, and its `data.path` is a
  readable absolute path. The driver reads it with the generic helper `flow_sdk.sources.read_file(file)`.
  `_check_outgoing` checks files against `files` instead of refusing them.

### 3.4 The runtime (`DriverRuntime` / `DataSource.send`), generic

- **Validation before any provider I/O** (`DataSource.send`). It resolves each path, derives `media_type` from the
  extension, and applies `as_` (`auto` becomes the kind of the media type). It refuses a kind or size the channel
  cannot take, with the fix in the message, for example: "WhatsApp images are 5 MB at most; chart.png is 7.2 MB. Send
  it with as_='document'." It never converts silently.
- **Fan-out.** When there are more files than `files.per_message` allows, the runtime makes N sends:
  - The body rides as the caption of the first file when `caption_max` allows. Otherwise it goes first as a text
    message.
  - Only the first part quotes `reply_to`.
  - `SendOutcome` gains `parts: tuple[str, ...]`, every provider id in order. `external_id` stays the first.
- **Inbound bytes are copied at ingest.** For each file on a new message from an `Openable` source, the runtime
  copies the bytes into `<records_data>/source_item/<id>/files/<name>`. That folder is durable, never `$TMPDIR` (see
  the 2026-09-23 attachment loss). A file that cannot be fetched keeps its metadata and records `fetch_error`, and
  the UI shows "not downloaded (expired)".
- **Reactions are applied, not threaded.** A `ReactionItem` is never a `SourceItem` message and never wakes a turn.
  It updates the reaction state of the target's `FlowMessage`:
  - `SET` replaces that person's set.
  - `ADD` and `REMOVE` edit it.
  - When the target is unknown, the reaction is dropped with a debug log.

### 3.5 The app (`flow_sdk/builtin`, `blocks`, `stream_inbox`, CLI, UI)

- **`ChannelSpec`** gains `quotes` and `reacts`. `accepts_attachments` is finally derived. All three come from the
  driver class: `files.kinds` not empty, `quotes`, and `isinstance(source, Reacting)` (a class-level check).
- **`FlowMessage`** gains `reactions: list[MessageReaction]`, where a `MessageReaction` is emoji, who (an origin key
  or principal), a display name and a time. A projected inbound file becomes a FILE `Attachment` pointing at the
  durable copy, so bubbles render images the way native chat does.
- **SDK.**
  - `Conversation.send(body, *, reply_to=None, files=())`
  - `Conversation.react(message, emoji)` and `Conversation.unreact(message, emoji="")`
  - `Delivered.react(emoji)`
  - `reply_spec(..., files=...)` (the parameter is renamed from `attachments`)
  - `MessageSpec.files: list[MessageFile]`. `MessageFile` has `path`, `as_="auto"` and `caption`, and a plain `str`
    path is accepted.
- **CLI.**
  - `flow conversation reply <cid> "text" [--reply-to <message-id>] [--file PATH ...]`
  - `flow conversation react <message-id> 👍 [--remove]`
- **UI.**
  - A bubble renders a quote block (from `reply_to_id`) and reaction chips.
  - Hovering a bubble shows **Reply** (or **Reply in thread** when `quotes` is false) and **React** when `reacts` is
    true.
  - The composer enables the paperclip for a source channel when `accepts_attachments` is true.
  - None of this reads a provider name.
- **The agent's turn.** An inbound quote reaches the agent as context ("replying to: «…»"). Inbound files reach it as
  local paths. The agent can answer with files through `flow conversation reply --file`.

## 4. Per-driver work, first pass

| driver | files | quotes | reactions |
|---|---|---|---|
| whatsapp | kinds all six, per_message 1, WhatsApp's limits, caption 1024 (image/video/document); `Openable` via `/{media_id}` | already true | `Reacting` (`type: reaction`); inbound `SET` |
| waha | the same kinds; voice sent with `convert: true`; `Openable` via `media.url` + key | already true | `Reacting` (`PUT /api/reaction`); subscribe to `message.reaction`; `SET` |
| telegram | photo/video/audio/voice/document/sticker, per_message 1 (albums later), caption 1024; `Openable` via `getFile` (20 MB) | move to `reply_parameters` | `Reacting` from the 73-emoji list; `allowed_updates` + `message_reaction`; `SET` |
| slack | external upload, per_message 10, caption 0 | stays false (thread) | `Reacting` with a name map inside the slack asset folder; `reaction_added/removed` `ADD/REMOVE` |
| gmail / cloud_email / agentmail | MIME / API attachments, per_message many | true (`In-Reply-To`); agentmail maps inbound `in_reply_to` | none |
| teams | later: the consent-card flow is personal-chat only | false | none: Graph reactions are delegated-only |
| helpdesk / http_chat / voice / agent | none (helpdesk through hub attachments later) | false | none |

## 5. Decisions needed before planning

1. **Should the agent's automatic answer quote the inbound message?** Today it always does on WhatsApp, WAHA and
   Telegram. Proposal: quote only when newer messages arrived before the answer. That is what people do; quoting
   every answer is noise in a 1:1 chat.
2. **Should an inbound reaction wake the agent?** Proposal: no. It is visible in history and the next turn's context.
3. **What is the size cap for copying at ingest?** Proposal: none beyond the provider's own limits (20 MB Telegram,
   100 MB WhatsApp documents). The alternative is a setting.
4. **Does Flowpad's own chat (the hub channel) get reactions in this plan?** Proposal: a follow-up part. It needs a hub
   field.
5. **Should the agent loop get an acknowledgement reaction?** An `ack_with="👀"` option would react on receipt.
   Proposal: yes, off by default.
