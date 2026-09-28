"""Reactions: a channel's reaction reports folded into state on the message they name.

A reaction is never a record of its own — it is not threaded, never wakes a turn and never reaches a
listener. ``apply_reactions`` writes the state onto the target's ``SourceItem.reactions`` (the truth,
kept across redelivery like ``read``) and its projected ``FlowMessage.reactions`` (what the surfaces
read). A reaction whose message this machine does not hold is dropped: there is nothing to show it on.

``react`` / ``unreact`` are the app's verbs: resolve a FlowMessage to the channel message it mirrors,
ask the driver, then record ours the same way an inbound report is recorded — so what a surface shows
after a click is what it would show after the provider's echo.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from flow_sdk.schema.data_spec.message_reaction_spec import MessageReaction
from flow_sdk.sources.files import normalize_emoji
from flow_sdk.sources.values.items import ReactionData, ReactionMode

logger = logging.getLogger(__name__)

#: ``MessageReaction.by`` for the reactions this machine put there — one identity per source, whatever
#: id the provider knows us by.
OURS = "self"


def fold(current: Iterable[MessageReaction], by: str, emojis: tuple[str, ...], mode: ReactionMode, *, by_name: Optional[str] = None, ours: bool = False, at: Optional[datetime] = None) -> list[MessageReaction]:
    """``current`` after one person's report. SET replaces their whole set; ADD / REMOVE edit it.
    Everyone else's entries are untouched, and the order of first appearance is kept. Emoji compare
    without the variation selector (❤ and ❤️ are one reaction) and keep the glyph they came with."""
    key = normalize_emoji
    kept = list(current)
    mine = {key(r.emoji): r for r in kept if r.by == by}
    others = [r for r in kept if r.by != by]
    given = {key(e): e for e in emojis}
    if mode is ReactionMode.SET:
        wanted = list(given)
    elif mode is ReactionMode.ADD:
        wanted = list(mine) + [k for k in given if k not in mine]
    else:
        wanted = [k for k in mine if k not in given]
    stamp = at or datetime.now(timezone.utc)
    fresh = [mine.get(k) or MessageReaction(emoji=given[k], by=by, by_name=by_name, ours=ours, at=stamp) for k in wanted]
    return others + fresh


async def _target(source: Any, origin: Any):
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    found = await SourceItem.find_existing(str(source.id), origin)
    if found is not None:
        return found
    # A provider that names one chat two ways (WhatsApp's @lid and @c.us) scopes the same message
    # differently in a reaction than in the message: its key alone, when unique in this source, is it.
    rows = await SourceItem.get_all({"data_source_id": str(source.id), "origin_kind": origin.kind, "origin_key": origin.key})
    return rows[0] if len(rows) == 1 else None


async def _store(item: Any, reactions: list[MessageReaction]) -> None:
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    if list(item.reactions or []) == reactions:
        return  # a redelivered report, a webhook retry: nothing moved
    item.reactions = reactions
    await item.save()
    message = await FlowMessage.get_one({"source_item_id": str(item.id)})
    if message is not None and list(message.reactions or []) != reactions:
        message.reactions = reactions
        await message.save()


async def apply_reactions(source: Any, items: Iterable[Any]) -> int:
    """Fold each reaction report into the message it names; answers how many landed."""
    from flow_sdk.stream_inbox.projection import is_self_address  # noqa: PLC0415

    landed = 0
    for item in items:
        data = item.data
        if not isinstance(data, ReactionData):
            continue
        target = await _target(source, data.target)
        if target is None:
            logger.debug("[reactions] %s: no message %s here; dropped", getattr(source, "id", "?"), data.target.key)
            continue
        by = data.sender.origin.key
        ours = is_self_address(source, by) or is_self_address(source, data.sender.address or "")
        folded = fold(
            target.reactions or [],
            OURS if ours else by,
            data.emojis,
            data.mode,
            by_name=None if ours else (data.sender.name or data.sender.address),
            ours=ours,
            at=data.sent_at,
        )
        await _store(target, folded)
        landed += 1
    return landed


async def source_item_of(message: Any):
    """The ``SourceItem`` a message mirrors — given one, or a FlowMessage, or a FlowMessage's id —
    or ``None`` when it did not come through a channel on this machine."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    if isinstance(message, SourceItem):
        return message
    if isinstance(message, str):
        message = await FlowMessage.get_one({"id": message})
    item_id = getattr(message, "source_item_id", None) or getattr(getattr(message, "origin_local", None), "source_item_id", None)
    return await SourceItem.get_one({"id": str(item_id)}) if item_id else None


async def _resolve(message: Any):
    """``(source row, driver, source item)`` for a message that mirrors a channel message."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    item = await source_item_of(message)
    if item is None or item.origin is None:
        raise ValueError("this message did not come through a channel on this machine; there is nothing to react to")
    source = await DataSource.get_by_id(item.data_source_id)
    driver = DataDriver.loaded(source.provider) if source is not None else None
    if driver is None:
        raise LookupError(f"the channel of message {getattr(message, 'id', '?')} is gone")
    return source, driver, item


async def react(message: Any, emoji: str) -> list[MessageReaction]:
    """Put our ``emoji`` on a channel message (its SourceItem, a FlowMessage or its id); answers its
    reactions after.
    On a channel that keeps one per person (``reactions_per_actor == 1``) it replaces ours."""
    if not emoji:
        raise ValueError("an emoji is required; unreact takes a reaction back")
    source, driver, item = await _resolve(message)
    await driver.react(source, item.origin, emoji)
    one = getattr(driver.cls, "reactions_per_actor", 0) == 1
    folded = fold(item.reactions or [], OURS, (emoji,), ReactionMode.SET if one else ReactionMode.ADD, ours=True)
    await _store(item, folded)
    return folded


async def unreact(message: Any, emoji: str = "") -> list[MessageReaction]:
    """Take back our ``emoji`` (all of ours with ``""``) from a channel message."""
    source, driver, item = await _resolve(message)
    await driver.react(source, item.origin, emoji, remove=True)
    folded = (
        fold(item.reactions or [], OURS, (emoji,), ReactionMode.REMOVE, ours=True)
        if emoji
        else fold(item.reactions or [], OURS, (), ReactionMode.SET, ours=True)  # "" takes back all of ours
    )
    await _store(item, folded)
    return folded


__all__ = ["OURS", "apply_reactions", "fold", "react", "source_item_of", "unreact"]
