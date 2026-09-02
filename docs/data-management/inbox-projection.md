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
fork and the message placement run under one per-loop dedupe lock: the two
lanes (sync ingest and the projected-tag handler) race in production, and an
unlocked lookup-then-create minted the same message twice.

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
the reconcile lane exists because a backfill announces nothing (storm caps in
`IngestMode`). Both funnel into `project_source_item`; the announcement fires
from there exactly once regardless of which lane won. See the module docstring
for the storm-cap reasoning and `data-sources.md` for the ingest side of the
fence.

