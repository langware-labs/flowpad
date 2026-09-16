"""One-shot backfill: stamp ``owner`` on rows written before the field existed.

``owner`` (a user or agent typeid) became a field on ``DataSource``,
``MessageThread`` and ``Conversation``. Every reader already resolves a row
that lacks it through ``inbox.projection.owner_of`` — a legacy source that
carries ``config.agent_id`` is that agent's, everything else is the local
user's — and the projection adopts an unowned thread into the owner that next
touches it. So nothing is WRONG on an un-backfilled instance; what is slow is
every owner filter and the ``_v2`` thread index missing rows whose ``owner``
is absent. This pass makes the column agree with the reader.

Per type:
  * ``data_source``   → ``owner_of(row)``.
  * ``message_thread`` → the owner of the source behind any message in the
    thread (a FlowMessage's ``source_item_id`` → SourceItem → DataSource);
    the local user when the thread has no source-backed message.
  * ``conversation``  → the owner of a thread that points at it; the local
    user when no thread does.

Re-saves through the entity model (``owner`` is a blob field, not a column) and
only rows whose ``owner`` is absent, so a backfilled instance reports zero.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_owner_backfill
    uv run -m flow_sdk.migrations.migration_2026_09_owner_backfill --apply
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

logger = logging.getLogger(__name__)


async def _repair(dry_run: bool) -> dict[str, int]:
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.message_thread import MessageThread
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
    from flow_sdk.inbox.projection import default_owner, owner_of

    def unowned() -> QueryFilter:
        # A fresh filter per query: the driver may fold type/scope constraints
        # into the node it is handed, so one object must not serve three reads.
        return QueryFilter(match=ExpressionNode(op=QueryOp.IS_NULL, operands=["owner"]))

    counts = {"data_source": 0, "message_thread": 0, "conversation": 0, "unresolved": 0}
    fallback = await default_owner()
    if fallback is None:
        raise RuntimeError("no local user row yet — run after the instance has bootstrapped")

    # Sources first: threads and conversations resolve THROUGH them.
    source_owner: dict[str, object] = {}
    for source in await DataSource.get_all(unowned()):
        owner = await owner_of(source)
        source_owner[str(source.id)] = owner
        counts["data_source"] += 1
        if not dry_run:
            source.owner = owner
            await source.save(notify=False)

    thread_owner: dict[str, object] = {}
    for thread in await MessageThread.get_all(unowned()):
        owner = None
        messages = await FlowMessage.get_all({"thread_id": str(thread.id)}, hydrate=False)
        for message in messages:
            item_id = getattr(message, "source_item_id", None)
            if not item_id:
                continue
            item = await SourceItem.get_one({"id": str(item_id)})
            if item is None or not item.data_source_id:
                continue
            owner = source_owner.get(str(item.data_source_id))
            if owner is None:
                source = await DataSource.get_one({"id": str(item.data_source_id)})
                owner = await owner_of(source) if source is not None else None
            if owner is not None:
                break
        if owner is None:
            owner = fallback
            counts["unresolved"] += 1
        thread_owner[str(thread.conversation_id)] = owner
        counts["message_thread"] += 1
        if not dry_run:
            thread.owner = owner
            await thread.save(notify=False)

    for conversation in await Conversation.get_all(unowned()):
        owner = thread_owner.get(str(conversation.id))
        if owner is None:
            thread = await MessageThread.get_one({"conversation_id": str(conversation.id)})
            owner = (thread.owner if thread is not None and thread.owner else None) or fallback
        counts["conversation"] += 1
        if not dry_run:
            conversation.owner = owner
            await conversation.save(None, notify=False)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        counts = asyncio.run(_repair(dry_run=dry_run))
    except Exception as e:  # noqa: BLE001
        logger.exception("Owner backfill failed: %s", e)
        return 1
    logger.info(
        "owner backfill: data_source=%d message_thread=%d conversation=%d (threads with no source-backed message → local user: %d)",
        counts["data_source"], counts["message_thread"], counts["conversation"], counts["unresolved"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
