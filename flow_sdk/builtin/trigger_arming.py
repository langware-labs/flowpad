"""Arming a trigger — the one place a Trigger row becomes live.

A Trigger row is inert until something subscribes it: APScheduler for a
schedule, the FSOp watcher for a watch, the event bus for a tag. That step used
to be reachable only from the seed path (``builtin_triggers._register_post_save``),
which was fine while every trigger was seeded. It is not fine now that a trigger
can arrive by being INDEXED off disk: the seed path never runs for it, the TAG
boot sweep has already happened, and the bus has no durability — so an unarmed
subscriber at emit time means the event is simply gone, with nothing anywhere
saying why the wizard never ran.

So arming is a function, called from both.
"""

from __future__ import annotations

import logging
from typing import Any

_log = logging.getLogger(__name__)


async def arm_trigger(entity: Any) -> None:
    """Subscribe this trigger to whatever fires it. Idempotent.

    Safe to call again on every re-index: ``register_tag_trigger``
    unregisters-then-registers, the FSOp arm is guarded on the watcher's task
    table, and a schedule job is replaced by id.
    """
    from flow_sdk.builtin.trigger import TriggerType  # noqa: PLC0415

    try:
        if entity.trigger_type == TriggerType.SCHEDULE:
            await entity._register_schedule_job()
        elif entity.trigger_type == TriggerType.FSOP:
            # The watcher's startup walk covers a trigger seeded BEFORE it
            # starts; this covers one that arrives after.
            from flow_sdk.server.fsop_watcher import fsop_watcher  # noqa: PLC0415

            if len(fsop_watcher) and entity.id not in fsop_watcher._tasks:
                await fsop_watcher.on_trigger_saved(entity)
        elif entity.trigger_type == TriggerType.TAG:
            from flow_sdk.builtin.tag_triggers import register_tag_trigger  # noqa: PLC0415

            register_tag_trigger(entity)
    except Exception:
        # Never fail the save (or the index) over a subscription. The row is
        # committed either way, and the next re-index re-arms.
        _log.exception("Arming failed for trigger %r", getattr(entity, "uname", entity.id))


async def arm_after_index(record: Any) -> None:
    """``post_sync_fn`` for TRIGGER — arm what the indexer just committed.

    Runs after the entity commit (``FSRecord.sync_to_db``), so the row this
    reads is the one on disk. Isolated by the caller: raising here warns and
    moves on rather than stopping the sync that already happened.
    """
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415

    entity = await Trigger.get_by_id(str(record.id))
    if entity is None:
        _log.debug("trigger %s indexed but not resolvable; nothing to arm", record.id)
        return
    await arm_trigger(entity)


async def disarm_trigger(trigger_id: str) -> None:
    """Unsubscribe a trigger whose asset is gone.

    The counterpart the index path needs and the seed path got from the orphan
    prune: deleting a trigger folder must not leave a live subscription behind,
    firing a callback whose declaration no longer exists.
    """
    try:
        from flow_sdk.builtin.tag_triggers import unregister_tag_trigger  # noqa: PLC0415

        unregister_tag_trigger(trigger_id)
    except Exception:
        _log.exception("Disarming failed for trigger %s", trigger_id)
