"""The inbox projection — ingested cloud records become Inbox conversations.

``SourceItem`` is the CACHE of a mutable cloud object; ``FlowMessage`` is how it
is rendered in a conversation. This module is the one-way projection between
them, and nothing else in the system knows both halves.

**Everything is derived, so everything is idempotent.**

    thread id       = uuid5(f"message_thread:{channel}:{thread_key}")
    conversation id = uuid5(f"conversation:{thread id}")
    message id      = uuid5(f"flow_message:source_item:{source item id}")

No lookup tables and no delivery ledger: re-projecting the whole corpus is a
no-op, which is what lets the reconcile sweep below be a blunt instrument.
``materialize_flow_message`` already upserts on a pre-populated id.

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

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

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


def channel_of(source) -> str:
    """The user-facing channel for a DataSource.

    Falls back to ``provider`` for rows written before ``channel`` existed —
    wrong-looking for the agent transport (whose provider is literally
    ``"agent"``), but stable, which is what identity needs. Configure
    ``channel`` on the source to fix the badge and the thread key together.
    """
    return (getattr(source, "channel", "") or getattr(source, "provider", "") or "").strip()


async def project_source_item(item, *, source=None, notify: bool = True,
                              recount: bool = True) -> Optional[str]:
    """Project one SourceItem into its conversation. Returns the FlowMessage id.

    Idempotent: the ids are derived, so a second call upserts the same rows.
    Returns None when the item cannot be placed (no source, no body) rather
    than raising — one bad record must not stall a sync.

    ``recount=False`` defers the thread recount to the caller. A sweep sets it:
    recounting per item is quadratic in thread depth, because each recount
    reloads the whole thread.
    """
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        ensure_conversation_entity,
        materialize_flow_message,
    )
    from flow_sdk.builtin.cloud_origin import CloudOrigin  # noqa: PLC0415
    from flow_sdk.ingest.drivers.channel_links import permalink_for  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

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
    thread_id = MessageThread.allocate_deterministic_id(channel, key)

    thread = await MessageThread.get_one({"id": thread_id})
    if thread is None:
        # The minted id is a BIRTH default only — once the thread exists, its
        # `conversation_id` is authoritative, because a merge repoints it and
        # that repoint is the whole reason the id is not derived from the key.
        thread = MessageThread(
            id=thread_id, channel=channel, thread_key=key,
            conversation_id=mint_uuid(f"conversation:{thread_id}"),
            title=subject or key, name=subject or key,
        )
        await thread.save(notify=False)
    conversation_id = thread.conversation_id

    # Defensive reads end here: `item` and `source` are typed entities.

    await ensure_conversation_entity(
        conversation_id, parent_typeid=None, someone_typeid=None,
        title=thread.title or subject or key,
    )

    sender_id, sender_name = await _sender_for(item, source, channel)
    fm_id = mint_uuid(f"flow_message:source_item:{item.id}")
    payload: dict[str, Any] = {
        "id": fm_id,
        "text": item.body or subject,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "thread_id": thread_id,
        "origin": CloudOrigin(
            kind=channel,
            provider=str(getattr(source, "provider", "") or ""),
            data_source_id=item.data_source_id or "",
            source_item_id=item.id or "",
            external_id=item.external_id or "",
            # The connector's link when it gives one; otherwise the channel's
            # own address formula, so "Open in Gmail" works for records whose
            # provider never supplied a URL.
            url=item.permalink or permalink_for(channel, item.external_id or "", key),
        ).model_dump(),
    }
    if item.reply_to_external_id:
        parent = SourceItem.allocate_deterministic_id(
            item.data_source_id, item.stream_key, item.reply_to_external_id)
        payload["reply_to_id"] = mint_uuid(f"flow_message:source_item:{parent}")

    # `bundle_ts` becomes the conversation pointer's timestamp, which is what
    # orders the feed — so a backfill lands in message time, not arrival order.
    fm = await materialize_flow_message(
        payload, conversation_id, someone_typeid=None,
        bundle_ts=(item.occurred_at or None),
        notify=notify,
    )
    await _refresh_projected_fields(fm, payload, notify=notify)
    if recount:
        await recompute_thread_projection(thread_id, thread=thread, notify=notify)
    return fm_id


#: The FlowMessage fields this projection OWNS. Everything else on the row —
#: `is_read`, `is_archived`, drafts, delivery state — is the user's and must
#: survive a refresh untouched.
_PROJECTED_MESSAGE_FIELDS = (
    "text", "sender_id", "sender_name", "thread_id", "reply_to_id", "origin",
)


async def _refresh_projected_fields(fm, payload: dict, *, notify: bool) -> None:
    """Re-apply the source snapshot to an already-materialized message.

    ``materialize_flow_message`` is deliberately create-only for local-origin
    payloads — "a local-origin re-materialize keeps the row untouched
    (idempotent upsert)" — which is right for a message we authored and wrong
    for one that CACHES a mutable cloud record. Without this, a subject edited
    in Gmail, a corrected sender, or a link the connector only started
    supplying would never reach the row: the SourceItem would move and the
    conversation would keep showing the first snapshot forever.

    Writes only the fields above, and only when one actually differs, so the
    common no-op poll costs nothing.
    """
    if fm is None:
        return
    changed = False
    for field in _PROJECTED_MESSAGE_FIELDS:
        if field not in payload:
            continue
        wanted = payload[field]
        current = getattr(fm, field, None)
        # `origin` round-trips as a model; compare on the wire shape so a
        # pydantic instance and its dump don't read as different every poll.
        if field == "origin" and current is not None and not isinstance(current, dict):
            current = current.model_dump()
        if current != wanted:
            setattr(fm, field, wanted)
            changed = True
    if changed:
        await fm.save(notify=notify)


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
    if address and _fold(address) in self_addresses(source):
        local = await User.get_local()
        if local and local.id:
            return str(local.id), display or "You"
    return (f"{channel}:{address}" if address else f"{channel}:unknown"), display or channel


async def recompute_thread_projection(thread_id: str, *, thread=None,
                                      notify: bool = True) -> None:
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

    The catch-up lane. Cheap because the FlowMessage id is DERIVED from the
    SourceItem id: "has this been projected?" is one bulk id query, not a join
    or a per-item probe.
    """
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    source = await DataSource.get_one({"id": data_source_id})
    if source is None:
        return 0
    # The kind gate belongs in the QUERY, not after it: a source that mixes
    # articles with mail would otherwise spend the whole `limit` budget on rows
    # it then drops, and re-fetch the same ones on every sweep forever.
    items = await SourceItem.get_all(QueryFilter(match=ExpressionNode(
        op=QueryOp.AND, operands=[
            ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", data_source_id]),
            ExpressionNode(op=QueryOp.LIKE, operands=["kind", f"{MESSAGE_KIND_ROOT}.%"]),
        ],
    ), limit=limit, order_by={"occurred_at": "asc"}))
    if not items:
        return 0
    wanted = {mint_uuid(f"flow_message:source_item:{i.id}"): i for i in items}
    existing = await FlowMessage.get_all(
        QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", list(wanted)]))
    )
    missing = [wanted[k] for k in wanted.keys() - {str(m.id) for m in existing}]
    if not missing:
        return 0
    # Oldest first, so conversation pointers land in message order even though
    # a provider hands them back newest-first.
    missing.sort(key=lambda i: i.occurred_at or "")
    projected = 0
    touched: set[str] = set()
    for item in missing:
        try:
            # Defer the recount: doing it per item reloads the whole thread each
            # time, which is quadratic in thread depth over a backfill.
            if await project_source_item(item, source=source, recount=False):
                projected += 1
                touched.add(MessageThread.allocate_deterministic_id(
                    channel_of(source), thread_key_for(item, item.name or "")))
        except Exception:  # noqa: BLE001 — one bad record must not stall the sweep
            logger.exception("[inbox] reconcile failed for source_item %s", item.id)
    for thread_id in touched:
        await recompute_thread_projection(thread_id)
    logger.info("[inbox] reconciled %d/%d items for source %s",
                projected, len(missing), data_source_id)
    return projected


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
        await project_source_item(item)
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
