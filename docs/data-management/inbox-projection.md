---
id: fbe83c6d-65fb-4299-9d53-bd17dd9b7570
---

# Inbox projection — ingested messages become conversations

The one-way projection from ingested cloud records to Inbox conversations, and
the module that owns it: `flow_sdk/inbox/projection.py`. Nothing else in the
system knows both halves.

## The reference model

A projected `FlowMessage` is a REFERENCE row, not a copy. It carries
membership (thread, conversation), attribution (sender, origin) and the
person's state (`is_read`); its `text` stays empty on disk and is hydrated at
read time from the `SourceItem` it references (`source_item_id`). An item edit
changes nothing here, and there is no snapshot-refresh machinery to keep in
step.

Identity is looked up, never derived: thread by `(channel, thread_key)`
(`MessageThread.find_existing`), conversation by the thread's
`conversation_id`, message by `source_item_id`. Ids are ordinary uuid4s minted
on first sight, so re-projecting the whole corpus converges on the same rows —
which is exactly what makes reindex a repair tool (below). Both the thread
fork and the message placement run under one per-loop dedupe lock
(`inbox/_locks.py`, keyed by the running loop so per-test loops cannot strand
it): the two lanes (the item-tag handler and the reconcile sweep) race in
production, and an unlocked lookup-then-create minted the same message twice.
The lock is taken only on a miss, so the already-placed re-poll never
serializes on it.

**What is admitted.** Only a `SourceItem` whose `kind` sits under
`MESSAGE_KIND_ROOT = "content.message"` (`content.message.email`,
`content.message.chat`) is inbox material; `content.feed.item` is an article
and is refused by `is_message` (a `tag_is_within` hierarchy match, not a
prefix compare). The reconcile sweep pushes the same gate into its query as
a `LIKE 'content.message.%'` so a mixed source cannot burn its batch on rows
it would drop.

**The keys.** `channel` is `DataSource.channel`, falling back to `provider`
for rows written before the field existed. `thread_key` is the driver's
native handle (`SourceItem.thread_key` — Gmail `threadId`, Slack `thread_ts`)
or, only when the driver gave none, `normalize_subject(name)` — a
multilingual reply/forward-prefix strip applied to a fixed point, with the
documented failure modes (two unrelated `Re: hello` threads collapse; a
subject edited mid-thread forks). A chat thread born without a subject is
titled by the root message's opening line, stamped once at birth.

**Attribution.** `_sender_for` maps an author that is one of the source's
own addresses (`account_identities`, plus `account_key` for legacy rows,
folded through `normalize_email`) to the local user — or to `agent:<id>` when
the source is an agent's mailbox (`config.agent_id`), so an agent's replies
are never put in the owner's mouth. Everyone else is `<channel>:<address>`.
This is load-bearing: both unread formulas gate on the sender, so a Sent-folder
item attributed to a stranger would count as unread mail. `reply_to_id` is
two lookups (parent item by natural key, then its message by
`source_item_id`) and is an accepted loss when the parent has not arrived.

## Two clocks — the timestamp law

A message has an **EVENT time** (when the human sent it: Slack `ts`, Telegram
`date`, an email's `Date:`) and **PROCESSING times** (when our rows were
written or edited: `created_date` / `updated_date`). Rendering the second as
the first is how a year-old Slack backfill once read "11h ago" in the inbox.
The law:

* **Event time is first-class.** Drivers normalize it ONCE at the edge —
  `SourceItemSpec.occurred_at` is canonical aware-UTC ISO (`+00:00`), every
  dialect (`Z`, naive, datetime) coerced by a validator. The projection stamps
  it onto the message as `FlowMessage.sent_at`, the projection being the ONE
  writer of that field. `sent_at` is PRIVATE: it is re-derivable locally from
  the item, and a hub LWW refresh must never blank it.
* **One read rule.** `FlowMessage.event_time = sent_at or updated_date or
  created_date` (mirrored as `eventTime` in ts_sdk). A channel-projected
  message is pinned to its `sent_at`; an authored message keeps its own
  clocks (an edit bumps recency); a hub-synced copy uses its adopted hub
  `created_date` (`flow_sdk/inbox/hub_clock.py`).
* **Every derivation reads `event_time`** — the conversation pointer `ts`,
  message order, and recency (`conv.updated_date = max(event_time)`) are all
  computed in `project_pointers_to_entity`
  (`flow_sdk/fs_store/operations/conversation.py`), the single writer of that
  projection. The UI renders only these derived values (pointer ts for
  bubbles, `conv.updated_date` for the list); **no surface may render a
  message's `created_date`/`updated_date` directly.**

## Reindex heals, by design

`project_source_item` is convergent: re-projecting an already-placed item
re-stamps a missing or drifted `sent_at` (the explicit heal in
`_place_message`'s resolve path — `materialize_flow_message` deliberately
no-op-upserts an existing local row, so the payload alone can never reach it)
and the pointer/recency rebuild then re-derives from the healed rows. The
reconcile sweep (`reconcile_source`, run after every sync) picks up not only
un-projected items but also placed items whose message lacks `sent_at`.

Consequence, and the promise this doc exists to keep: **mis-dated inbox data
is repaired by the standard paths** — a sync, a "Pull changes", a replay — with
no bespoke migration, for today's legacy rows and for any future corruption of
the same shape.

## The two lanes

The per-item lane (`ingest.*.item.created|updated` tags) is the steady state;
the reconcile lane (`ingest.*.sync.completed` → `reconcile_source`, at most
`RECONCILE_BATCH` = 500 items per sweep, oldest first) exists because a
backfill announces nothing (storm caps in `IngestMode`). Both funnel into
`project_source_item`. See the module docstring for the storm-cap reasoning
and [data-sources.md](data-sources.md#the-pipeline) for the ingest side of the
fence.

Both lanes are armed by `start_inbox_projection`, which `flow_sdk.inbox.start_inbox`
calls at server startup **before** subscribing the agent runner — the runner
keys off the projection's own announcement, so the order is a contract.
The item handler re-reads the `SourceItem` row (the event carries an id, not
a body) and re-projects idempotently on `.updated`.

**The announcement.** A placed message is announced as
`inbox.<provider>.message.projected` (target `source_item:<id>`, scope
`data_source:<id>`; `inbox/inbox_on_tag.py`) — a different fact from
`ingest.*.item.created`, because a thread's `conversation_id` does not exist
until the projection has committed, and a consumer on the ingest tag would be
racing that write. Whether to announce is decided by the **lane**, not by
whether the row pre-existed: the item lane announces on `.created` and not on
`.updated`; the sweep announces per item only when the batch of un-placed
items is at or under `STORM_CAP_PER_MINUTE` (30) and never for the
`sent_at`-heal leg. `project_source_item` itself does not check whether it
created or re-found the row, so if the sweep places an item before its
`.created` handler runs, that handler announces it a second time.

## What a purge does

`DataSource.purge_records_of` (behind `purge_items`, `replay` and every
source-delete path) calls `remove_projection_for_items`: the reference rows
for the doomed items are destroyed, their conversation pointers pruned, each
touched thread recounted or destroyed when empty, and a conversation with no
messages and no threads left goes with it. Mandatory under the reference
model, not hygiene: an orphaned reference renders blank. Hub-native messages
never carry `source_item_id`, so a mixed conversation loses only its channel
half.

## The rest of `flow_sdk/inbox/`

* `__init__.py` — the unread projection: `touch(reason)` is the fire-and-forget
  recompute every mutation site (including this projection) calls;
  `recompute_unread` is the awaited form. Never deltas — every recompute starts
  from the canonical rows.
* `outbound.py` — the inverse direction, and deliberately small: resolves
  *where* a reply goes and hands it to the driver's `send`; the sent copy
  re-enters through ingest and projects like any other item.
* `agent_runner.py` — mail to an agent's own mailbox becomes a turn in one
  headless process per conversation; subscribed on `inbox.*.message.projected`.
  The allowlist is also the loop breaker for the agent's own ingested replies.
* `catchup.py` — the hub-side one-shot `conversation-list` sweep on startup and
  cloud login, because the hub's WebSocket fan-out is live-only.
* `hub_clock.py` — adopt the hub's `created_date` on `Conversation`/`FlowMessage`
  outside the staleness check, so a locally re-created row cannot defend a
  wrong birth time.
