"""The inbox projection — ingested cloud records become Inbox conversations.

``SourceItem`` is the CACHE of a mutable cloud object; ``FlowMessage`` is how it
is rendered in a conversation. This module is the one-way projection between
them, and nothing else in the system knows both halves.

**Identity is looked up, so everything is idempotent.**

    thread        resolved by (channel, thread_key)   — MessageThread.find_existing
    conversation  thread.conversation_id              — authoritative once born
    message       resolved by source_item_id          — the reference column

Ids are ordinary uuid4s, minted only on first sight; re-projecting the whole
corpus converges on the same rows by lookup, which is what lets the reconcile
sweep below be a blunt instrument. ``materialize_flow_message`` already upserts
on a pre-populated id.

**A projected FlowMessage is a REFERENCE row, not a copy.** It carries
membership (thread, conversation), attribution (sender, origin) and the
person's state (``is_read``); its ``text`` stays empty on disk and is hydrated
at read time from the SourceItem it references — so an item edit changes
nothing here, and there is no snapshot-refresh machinery to keep in step.

**Two lanes, and both are load-bearing.** The per-item lane is the steady
state. The reconcile lane exists because ``ingest_items`` emits item tags ONLY
in ``IngestMode.INCREMENTAL``, and ``IngestMode.for_run`` picks BACKFILL on the
first run or when a cycle carries more than ``STORM_CAP_PER_MINUTE`` (30)
items — so a first sync of a real mailbox announces *nothing*. The sweep also
deliberately ignores ``changed_ids``: the agent transport's worker writes
through ``flow record create``, a separate ``ingest_items`` call, so the
driver's own report is empty.
"""

from __future__ import annotations

import asyncio
import logging
import re
import weakref
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Serializes thread resolve+create. The old derived id made concurrent item
# events converge on one row for free; a lookup-then-create races, and two
# events on a new thread would fork it (two rows, two conversations). Keyed per
# running event loop, not one module Lock — an asyncio.Lock is loop-scoped, and
# per-test loops tear down while fire-and-forget work may hold it (same shape,
# and same reasoning, as ``flow_sdk/inbox/__init__._recompute_locks``).
_thread_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)


def _thread_lock() -> "asyncio.Lock":
    loop = asyncio.get_running_loop()
    lock = _thread_locks.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _thread_locks[loop] = lock
    return lock

#: How many un-projected items one reconcile pass will catch up. A first Gmail
#: sync is a few hundred; this bounds the work per `sync.completed` without a
#: cursor, because the next sync's sweep picks up whatever is left.
RECONCILE_BATCH = 500

#: Reply/forward prefixes stripped when a provider gives us no native thread
#: handle and the subject is all we have. Deliberately multi-lingual: a
#: two-entry English list silently forks every non-English thread. Applied
#: repeatedly to a fixed point, so `Re: Fwd: RE:` collapses.
_SUBJECT_PREFIX = re.compile(
    r"^\s*(?:re|rif|aw|antw|sv|vs|vb|res|enc|tr|fwd?|wg|encaminhada|回复|答复|转发)\s*(?:\[\d+\])?\s*:\s*",
    re.IGNORECASE,
)
#: Bracketed list/banner tags: `[team]`, `[EXTERNAL]`.
_SUBJECT_TAG = re.compile(r"^\s*\[[^\]]{1,40}\]\s*")


def normalize_subject(subject: str) -> str:
    """A subject reduced to its threading key.

    The FALLBACK thread key — used only when the provider offers nothing
    better. Every channel worth supporting ships a native handle (Gmail
    ``threadId``, Slack ``thread_ts``, a Jira issue key) and the driver should
    put it in ``SourceItem.thread_key``; this is what happens when it can't.

    Known and accepted failure modes, documented so nobody rediscovers them as
    bugs: two unrelated ``Re: hello`` threads collapse into one, and editing a
    subject mid-thread forks it. Both are why the native handle wins when it
    exists, and why the key is also scoped by channel and account.
    """
    text = (subject or "").strip()
    while True:
        stripped = _SUBJECT_TAG.sub("", _SUBJECT_PREFIX.sub("", text))
        if stripped == text:
            break
        text = stripped
    return " ".join(text.split()).casefold()


def thread_key_for(item, subject: str) -> str:
    """The item's grouping key: the driver's handle, else the subject."""
    native = (item.thread_key or "").strip()
    return native or normalize_subject(subject)


#: The ontology subtree this projection accepts. `SourceItem.kind` is what
#: separates a MESSAGE from a document: `content.message.email` and
#: `content.message.chat` belong in an inbox, `content.feed.item` (an RSS entry,
#: a Hacker News story) emphatically does not — it is an article, and projecting
#: it produced a 300-row inbox of news headlines the first time this ran.
MESSAGE_KIND_ROOT = "content.message"


def is_message(item) -> bool:
    """Whether an ingested record belongs in the Inbox at all.

    Hierarchy match, not a prefix compare — `tag_is_within` is the shared
    dot-taxonomy owner and is lenient about case/whitespace, so an untrusted
    provider string can't slip through on formatting.
    """
    from flow_sdk.tags.grammar import tag_is_within  # noqa: PLC0415

    return tag_is_within(item.kind or "", MESSAGE_KIND_ROOT)


def _thread_title(item) -> str:
    """A chat thread's display title: the root message's opening line.

    First line only, bounded, ellipsized on a word where possible. Empty when
    the item has no body — the caller then falls back to the thread key.
    """
    opening = (getattr(item, "body", "") or "").strip().splitlines()[0:1]
    text = opening[0].strip() if opening else ""
    if len(text) <= 60:
        return text
    cut = text[:60].rsplit(" ", 1)[0] or text[:60]
    return f"{cut}…"


def channel_of(source) -> str:
    """The user-facing channel for a DataSource.

    Falls back to ``provider`` for rows written before ``channel`` existed —
    wrong-looking for the agent transport (whose provider is literally
    ``"agent"``), but stable, which is what identity needs. Configure
    ``channel`` on the source to fix the badge and the thread key together.
    """
    return (getattr(source, "channel", "") or getattr(source, "provider", "") or "").strip()


async def project_source_item(
    item, *, source=None, notify: bool = True, recount: bool = True, announce: bool = True
) -> Optional[tuple[str, str]]:
    """Project one SourceItem into its conversation.

    Returns ``(flow_message_id, thread_id)``, or None when the item cannot be
    placed (no source, not a message) rather than raising — one bad record
    must not stall a sync. Idempotent: identity is resolved by lookup (thread
    by natural key, message by ``source_item_id``), so a second call converges
    on the same rows.

    ``recount=False`` defers the thread recount to the caller. A sweep sets it:
    recounting per item is quadratic in thread depth, because each recount
    reloads the whole thread.

    ``announce=False`` suppresses the projected tag. A sweep sets it when the
    batch itself would be a storm, for the reason `IngestMode` encodes one layer
    down: the caps are 30/min and raising them is not an option. Announcing each
    of a 500-item import would put 500 events into that cap — and on an agent
    mailbox each surviving one spends a real turn answering months-old mail.

    The announcement still fires from HERE rather than from a lane, because the
    two lanes race and either may do the write; the incremental lane calls this
    function whether or not the sweep got there first, so the announcement
    lands exactly once without a lane having to know who won.
    """
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        ensure_conversation_entity,
        materialize_flow_message,
    )
    from flow_sdk.fs_store.origin.cloud_origin import CloudOrigin, CloudOriginLocal  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.ingest.drivers.channel_links import permalink_for  # noqa: PLC0415

    if not is_message(item):
        return None  # a feed article is not inbox material — see MESSAGE_KIND_ROOT
    if source is None:
        source = await DataSource.get_one({"id": item.data_source_id})
    if source is None:
        logger.debug("[inbox] item %s has no DataSource — skipped", item.id)
        return None

    channel = channel_of(source)
    subject = item.name or ""
    key = thread_key_for(item, subject)

    # Resolve-or-create under the lock: the derived id used to absorb this
    # race for free, a lookup does not — two concurrent events on a brand-new
    # thread would each miss and fork it.
    async with _thread_lock():
        thread = await MessageThread.find_existing(channel, key)
        if thread is None:
            # Both ids are ordinary uuid4s, minted here at birth and looked up
            # ever after. `conversation_id` is authoritative from this moment:
            # a merge repoints it, which is the whole reason nothing re-derives
            # it from the key.
            thread = MessageThread(
                id=mint_uuid(),
                channel=channel,
                thread_key=key,
                conversation_id=mint_uuid(),
                # A mail thread titles by subject. A chat message has none, and
                # falling back to the KEY put raw Slack ts digits in the inbox;
                # the root message's opening is what Slack itself titles a
                # thread by. Stamped at birth only, so it never churns.
                title=subject or _thread_title(item) or key,
                name=subject or _thread_title(item) or key,
            )
            await thread.save(notify=False)
    thread_id = str(thread.id)
    conversation_id = thread.conversation_id

    # Defensive reads end here: `item` and `source` are typed entities.

    await ensure_conversation_entity(
        conversation_id,
        parent_typeid=None,
        someone_typeid=None,
        title=thread.title or subject or key,
    )

    sender_id, sender_name = await _sender_for(item, source, channel)
    # The message row is resolved by its reference column — reuse the existing
    # row's id, mint an ordinary uuid4 only on first placement.
    existing_fm = await FlowMessage.get_one({"source_item_id": str(item.id)})
    fm_id = str(existing_fm.id) if existing_fm is not None else mint_uuid()
    payload: dict[str, Any] = {
        "id": fm_id,
        # A reference row: the body lives on the SourceItem and is hydrated at
        # read time. `FlowMessage.save()` enforces the blank.
        "text": "",
        "source_item_id": str(item.id),
        "sender_id": sender_id,
        "sender_name": sender_name,
        "thread_id": thread_id,
        "origin": CloudOrigin(
            kind=channel,
            provider=str(getattr(source, "provider", "") or ""),
            external_id=item.external_id or "",
            # The connector's link when it gives one; otherwise the channel's
            # own address formula, so "Open in Gmail" works for records whose
            # provider never supplied a URL.
            url=item.permalink or permalink_for(channel, item.external_id or "", key),
        ).model_dump(),
        # The half that stays home. Written alongside, refreshed alongside, but
        # carried by a PRIVATE field so a shared message does not ship row ids
        # that only resolve here.
        "origin_local": CloudOriginLocal(
            data_source_id=item.data_source_id or "",
            source_item_id=item.id or "",
        ).model_dump(),
    }
    if item.reply_to_external_id:
        # Two lookups, no derivation: the parent item by its natural key, then
        # its message row by the reference column. A parent that has not
        # arrived — or arrived but is not yet projected — yields no
        # `reply_to_id`. Accepted loss vs the derived form: a child projected
        # before its parent keeps a null `reply_to_id` (nothing heals it
        # later); both lanes project oldest-first, which covers the normal case.
        parent = await SourceItem.find_existing(
            item.data_source_id, item.segment_key, item.reply_to_external_id
        )
        if parent is not None:
            parent_fm = await FlowMessage.get_one({"source_item_id": str(parent.id)})
            if parent_fm is not None:
                payload["reply_to_id"] = str(parent_fm.id)

    # `bundle_ts` becomes the conversation pointer's timestamp, which is what
    # orders the feed — so a backfill lands in message time, not arrival order.
    await materialize_flow_message(
        payload,
        conversation_id,
        someone_typeid=None,
        bundle_ts=(item.occurred_at or None),
        notify=notify,
    )
    if recount:
        await recompute_thread_projection(thread_id, thread=thread, notify=notify)
    if announce:
        from flow_sdk.inbox.inbox_on_tag import emit_projected_tag  # noqa: PLC0415

        emit_projected_tag(item)
    return fm_id, thread_id


def self_addresses(source) -> set[str]:
    """Every address that means "me" on this source, casefolded.

    `account_identities` is the field for it; `account_key` is included only
    because it is what a source configured before that field existed had —
    for a mailbox it is often the address anyway.
    """
    values = list(getattr(source, "account_identities", None) or [])
    values.append(str(getattr(source, "account_key", "") or ""))
    return {_fold(v) for v in values if v and v.strip()}


def _fold(value: str) -> str:
    """Compare-form for an address or handle.

    `normalize_email` is the documented funnel for every email entering the
    system ("strip + lowercase"), so use it — a parallel `casefold()` here
    would diverge on non-ASCII (`ß` → `ss`) and silently fail to recognise our
    own mail, which is the exact failure `_sender_for` exists to prevent. Non-
    email handles (a Slack user id) fall through its passthrough unchanged.
    """
    from flow_sdk.builtin.user import normalize_email  # noqa: PLC0415

    text = (value or "").strip()
    return normalize_email(text) or text.lower()


def display_name_of(raw: str, address: str) -> str:
    """A human name from whatever the provider handed us.

    Providers are inconsistent here: some give `"Ada Lovelace" <ada@x.io>`,
    some a bare name, some the address twice. `parseaddr` is the stdlib's
    RFC 5322 reader — it unescapes quoted names and tolerates trailing junk
    (`"Ada" <a@x.io> (via list)`), both of which a hand-rolled split gets
    wrong. Falls back to the address so a byline is never empty.
    """
    from email.utils import parseaddr  # noqa: PLC0415

    text = (raw or "").strip()
    name = parseaddr(text)[0].strip() if text else ""
    return name or text or address


async def _sender_for(item, source, channel: str) -> tuple[str, str]:
    """``(sender_id, sender_name)`` — mapping our own account to the local user.

    Load-bearing, not cosmetic. Both unread formulas gate on the sender
    (``inbox.count_unread``, and ``conversationFacets`` on the frontend), so an
    item WE authored — every message in a Sent folder, and every reply we send
    once Part 2 lands — would otherwise count as unread mail from a stranger.

    External senders get ``<channel>:<address>``: non-empty (an empty sender_id
    is never counted unread at all) and never a self id.
    """
    from flow_sdk.builtin.user import User  # noqa: PLC0415

    address = (item.author_external_id or "").strip()
    display = display_name_of(item.author_display or "", address)
    if is_self_address(source, address):
        # An AGENT's mailbox is not the user's. Attributing its sent copies to
        # the human would put words in their mouth — the owner would appear to
        # have written replies they never saw. Same reasoning as
        # `ConversationKind.HELPDESK`, where a reply carries one non-human
        # identity rather than the individual who happened to send it.
        agent_sender = await _agent_sender_for(source)
        if agent_sender:
            return agent_sender[0], agent_sender[1] or display or "Agent"
        local = await User.get_local()
        if local and local.id:
            return str(local.id), display or "You"
    return (f"{channel}:{address}" if address else f"{channel}:unknown"), display or channel


#: Sender-id prefix for a hosted agent. Deliberately NOT a bare entity id: a
#: sender id is compared against user ids, and an agent that looked like one
#: would be indistinguishable from a person in every consumer.
AGENT_SENDER_PREFIX = "agent"


def agent_sender_id(agent_id: str) -> str:
    return f"{AGENT_SENDER_PREFIX}:{agent_id}"


def is_agent_sender(sender_id: str) -> bool:
    """Was this message written by an agent whose mailbox we hold?

    The prefix IS the answer — that is the whole reason `agent_sender_id` uses
    one instead of a bare entity id. Consumers that instead enumerate agent rows
    to build a set get a different answer over time: an agent whose mail is
    later switched off drops out of the set, and its past replies start counting
    as unread mail from a stranger.
    """
    return (sender_id or "").startswith(f"{AGENT_SENDER_PREFIX}:")


def agent_id_of(source) -> str:
    """The agent whose mailbox this source is, or ``""``.

    `config.agent_id` is the cloud-mailbox driver's one load-bearing key — the
    address is allocated and may change, the agent id cannot — so every reader
    of it comes here rather than re-spelling the lookup. `config` really is an
    untyped dict, which is why the defensive read is justified here and nowhere
    else in this file.
    """
    return str((getattr(source, "config", None) or {}).get("agent_id") or "").strip()


def is_self_address(source, address: str) -> bool:
    """Is this address one of OUR account's on that source?

    The one place the folding rule is applied. `self_addresses` is public but
    `_fold` is not, and a second caller reaching for the private half is how the
    normalization funnel starts to diverge.
    """
    folded = (address or "").strip()
    return bool(folded) and _fold(folded) in self_addresses(source)


async def _agent_sender_for(source) -> "tuple[str, str] | None":
    """``(sender_id, display)`` when this source is an agent's own mailbox."""
    agent_id = agent_id_of(source)
    if not agent_id:
        return None
    from flow_sdk.builtin.agent import Agent  # noqa: PLC0415

    agent = await Agent.get_by_id(agent_id)
    return agent_sender_id(agent_id), str(getattr(agent, "name", "") or "")


async def recompute_thread_projection(thread_id: str, *, thread=None, notify: bool = True) -> None:
    """Recount a thread from its messages and publish iff something changed.

    The count lives here rather than on each message because the conversation
    view fetches a bounded window (``CONVERSATION_MESSAGES_WINDOW``, 500) with
    no pagination — a client-side count is silently wrong for a real mailbox,
    and the packed row needs the count without loading the thread.
    """
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.core.entity.projected_fields import PROJECTION_SENTINEL  # noqa: PLC0415

    if thread is None:
        thread = await MessageThread.get_one({"id": thread_id})
    if thread is None:
        return
    count = len(await FlowMessage.get_all({"match": {"thread_id": thread_id}}))
    if not count or thread.message_count == count:
        return  # idempotent early-out — no save, no broadcast
    thread._set_projection("message_count", count, PROJECTION_SENTINEL)
    await thread.save(notify=notify)


async def reconcile_source(data_source_id: str, *, limit: int = RECONCILE_BATCH) -> int:
    """Project every SourceItem of one source that has no message yet.

    The catch-up lane. Cheap because a projected message carries its
    ``source_item_id``: "has this been projected?" is one bulk IN query over
    the indexed reference column, not a join or a per-item probe.
    """
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    source = await DataSource.get_one({"id": data_source_id})
    if source is None:
        return 0
    # The kind gate belongs in the QUERY, not after it: a source that mixes
    # articles with mail would otherwise spend the whole `limit` budget on rows
    # it then drops, and re-fetch the same ones on every sweep forever.
    items = await SourceItem.get_all(
        QueryFilter(
            match=ExpressionNode(
                op=QueryOp.AND,
                operands=[
                    ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", data_source_id]),
                    ExpressionNode(op=QueryOp.LIKE, operands=["kind", f"{MESSAGE_KIND_ROOT}.%"]),
                ],
            ),
            limit=limit,
            order_by={"occurred_at": "asc"},
        )
    )
    if not items:
        return 0
    existing = await FlowMessage.get_all(
        QueryFilter(
            match=ExpressionNode(
                op=QueryOp.IN, operands=["source_item_id", [str(i.id) for i in items]]
            )
        ),
        hydrate=False,  # placement check reads ids only
    )
    placed = {str(m.source_item_id) for m in existing}
    missing = [i for i in items if str(i.id) not in placed]
    if not missing:
        return 0
    # Oldest first, so conversation pointers land in message order even though
    # a provider hands them back newest-first.
    missing.sort(key=lambda i: i.occurred_at or "")

    # Announce per item only when this sweep is not itself a storm. The cap is
    # the real condition — NOT "is this the first sync". A mailbox's first poll
    # is always a backfill by `IngestMode`, and gating on that would mean an
    # agent never answers the first mail it ever receives, while a genuine
    # 500-message import would still need silencing. Size answers both.
    from flow_sdk.ingest.models import STORM_CAP_PER_MINUTE  # noqa: PLC0415

    announce = len(missing) <= STORM_CAP_PER_MINUTE
    if not announce:
        # Said out loud: a silent cap reads downstream as "nothing arrived".
        logger.info(
            "[inbox] %d items exceed the %d/min cap — projecting %s without per-item events",
            len(missing),
            STORM_CAP_PER_MINUTE,
            data_source_id,
        )

    projected = 0
    touched: set[str] = set()
    for item in missing:
        try:
            # Defer the recount: doing it per item reloads the whole thread each
            # time, which is quadratic in thread depth over a backfill.
            result = await project_source_item(item, source=source, recount=False, announce=announce)
            if result:
                projected += 1
                touched.add(result[1])
        except Exception:  # noqa: BLE001 — one bad record must not stall the sweep
            logger.exception("[inbox] reconcile failed for source_item %s", item.id)
    for thread_id in touched:
        await recompute_thread_projection(thread_id)
    logger.info("[inbox] reconciled %d/%d items for source %s", projected, len(missing), data_source_id)
    return projected


async def remove_projection_for_items(item_ids, *, notify: bool = True) -> int:
    """Delete the reference rows for purged SourceItems and heal their containers.

    Mandatory under the reference model, where it was merely hygiene under the
    copy: an orphaned reference renders BLANK, not stale-but-readable, so a
    purge that left the messages behind would fill the inbox with empty rows.

    Per doomed message: destroy the row, prune its conversation pointer. Then
    per touched thread: recount, or delete it when nothing remains; a
    conversation with no messages and no threads left goes with it. Hub-native
    messages never carry ``source_item_id``, so a mixed conversation only ever
    loses its channel half.
    """
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.operations.conversation import prune_message_pointer  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    ids = [str(i) for i in item_ids if i]
    if not ids:
        return 0
    doomed = await FlowMessage.get_all(
        QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["source_item_id", ids])),
        hydrate=False,
    )
    if not doomed:
        return 0

    touched_threads = {str(fm.thread_id) for fm in doomed if fm.thread_id}
    touched_convs = {str(fm.conversation_id) for fm in doomed if fm.conversation_id}
    for fm in doomed:
        conv_id = str(fm.conversation_id or "")
        try:
            await fm.destroy()
        except Exception:  # noqa: BLE001 — one stuck row must not stall the purge
            logger.exception("[inbox] purge: destroy failed for flow_message %s", fm.id)
            continue
        if conv_id:
            try:
                rec = FSRecord(type=RecordType.CONVERSATION, id=conv_id)
                await prune_message_pointer(rec, str(fm.id), notify=notify)
            except Exception:  # noqa: BLE001
                logger.exception("[inbox] purge: pointer prune failed fm=%s conv=%s", fm.id, conv_id)

    for thread_id in touched_threads:
        thread = await MessageThread.get_one({"id": thread_id})
        if thread is None:
            continue
        remaining = await FlowMessage.get_all(
            QueryFilter(
                match=ExpressionNode(op=QueryOp.EQ, operands=["thread_id", thread_id]), limit=1
            ),
            hydrate=False,
        )
        if remaining:
            await recompute_thread_projection(thread_id, thread=thread, notify=notify)
        else:
            await thread.destroy()

    for conv_id in touched_convs:
        remaining = await FlowMessage.get_all(
            QueryFilter(
                match=ExpressionNode(op=QueryOp.EQ, operands=["conversation_id", conv_id]), limit=1
            ),
            hydrate=False,
        )
        threads_left = await MessageThread.get_all(
            QueryFilter(
                match=ExpressionNode(op=QueryOp.EQ, operands=["conversation_id", conv_id]), limit=1
            )
        )
        if not remaining and not threads_left:
            conv = await Conversation.get_one({"id": conv_id})
            if conv is not None:
                await conv.destroy()

    _touch()
    return len(doomed)


# ── bus wiring ───────────────────────────────────────────────────────────────

_started = False


def start_inbox_projection() -> None:
    """Arm both lanes. Idempotent; called at server startup."""
    global _started
    if _started:
        return
    _started = True
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    on_tag("ingest.*.item.created", _on_item)
    on_tag("ingest.*.item.updated", _on_item)
    on_tag("ingest.*.sync.completed", _on_sync)
    logger.info("[inbox] projection armed (item + reconcile lanes)")


async def _on_item(event) -> None:
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    entity_id = str((event.data or {}).get("entity_id") or "")
    if not entity_id:
        return
    try:
        item = await SourceItem.get_one({"id": entity_id})
        if item is None:
            return
        # Announce ARRIVAL, not every write. This lane is armed for `.created`
        # AND `.updated`, and `project_source_item` is an idempotent upsert — so
        # announcing on an update re-announces a message that is already placed,
        # and a consumer that acts on the announcement acts twice. For the agent
        # runner that means a second billable turn answering mail it already
        # answered. The ingest lane draws the same line one level down, where
        # `emit_item_tag` returns early on `unchanged`.
        first_placement = event.tag.rsplit(".", 1)[-1] == "created"
        await project_source_item(item, announce=first_placement)
        _touch()
    except Exception:  # noqa: BLE001 — never fail the ingest that triggered us
        logger.exception("[inbox] projection failed for source_item %s", entity_id)


async def _on_sync(event) -> None:
    source_id = str((event.data or {}).get("source_id") or "")
    if not source_id:
        return
    try:
        if await reconcile_source(source_id):
            _touch()
    except Exception:  # noqa: BLE001
        logger.exception("[inbox] reconcile failed for source %s", source_id)


def _touch() -> None:
    """Republish the unread badge.

    ``inbox.touch`` and NOT ``recompute_unread``: the awaited form is for
    callers that must observe the fresh value, and a full recompute is a
    whole-table scan under a global lock. Awaiting one per item event would
    put up to STORM_CAP_PER_MINUTE of those on the ingest handler's critical
    path; the fire-and-forget form is what every other mutation site uses.
    """
    from flow_sdk import inbox  # noqa: PLC0415

    inbox.touch("inbox-projection")
