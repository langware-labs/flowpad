"""Read state: what the account's owner has read, kept the same here and at the provider.

Two facts per message, and one rule between them. ``SourceItem.read`` is the provider's state as
last known; ``FlowMessage.is_read`` is what the person sees here.

* A provider report (``MessageData.read`` at birth, a ``ReadData`` item after) that DIFFERS from
  ``SourceItem.read`` is a change made at the provider: both move to it.
* One that EQUALS it changed nothing there — a redelivery, or the echo of our own write — and is
  dropped, so it never undoes what the person did here since.
* A change made here is written to the provider (``push_read``) when the channel can and the
  source says to (``ReadMarking``); once written, ``SourceItem.read`` holds it.

No timestamps: the rule compares states, so duplicate reports, retries and restarts converge.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from flow_sdk.sources.values.items import ReadData

logger = logging.getLogger(__name__)


async def apply_reads(source: Any, items: Iterable[Any]) -> None:
    """Apply each read-state report (a ``ReadData`` item) to the message it names."""
    from flow_sdk import stream_inbox  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.stream_inbox.reactions import _target  # noqa: PLC0415

    moved = False
    for item in items:
        data: ReadData = item.data
        target = await _target(source, data.target)
        if target is None or bool(target.read) == data.read:
            continue  # not held here, or nothing changed at the provider
        target.read = data.read
        await target.save()
        message = await FlowMessage.get_one({"source_item_id": str(target.id)})
        if message is not None and bool(message.is_read) != data.read:
            message.is_read = data.read
            await message.save()
            moved = True
    if moved:
        stream_inbox.touch("provider-read")


async def push_read(message: Any) -> None:
    """Write ``message``'s read state (a FlowMessage, already saved) to the provider it came from.
    Never raises: the read is the person's here whatever the provider says, so a refusal is logged
    and the two stay apart until the provider's next report."""
    from flow_sdk.stream_inbox.reactions import channel_of_source, source_item_of  # noqa: PLC0415

    try:
        item = await source_item_of(message)
        read = bool(message.is_read)
        if item is None or item.origin is None or item.sent_by_us or bool(item.read) == read:
            return
        source, driver = await channel_of_source(item.data_source_id, what="this message")
        if await driver.mark_read(source, item.origin, read):
            item.read = read
            await item.save()
    except Exception:  # noqa: BLE001 — a provider's refusal must not fail the person's own mark
        logger.warning("[reads] could not write the read state of %s to its provider", getattr(message, "id", "?"), exc_info=True)


#: The name of a write-back task — what a test waits on.
WRITE_BACK = "read-write-back"


def write_back(messages: Iterable[Any]) -> None:
    """What a mark made here calls after its save: write the read state of ``messages`` to their
    providers, detached — the person's mark never waits on a mailbox, and never fails with one."""
    from flow_sdk.request_context.detached import create_detached_task  # noqa: PLC0415

    batch = list(messages)
    if not batch:
        return

    async def _run() -> None:
        for message in batch:
            await push_read(message)

    try:
        create_detached_task(_run(), name=WRITE_BACK)
    except RuntimeError:
        logger.debug("[reads] write-back skipped — no running event loop")
