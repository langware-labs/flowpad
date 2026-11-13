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
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)


def is_foreign_copy(asset_ref: str | None) -> bool:
    """True when ``asset_ref`` sits in a shipped system project of ANOTHER install.

    The same shipped trigger exists once per install on the machine — an older
    interpreter's tool env, a repo checkout opened as a project — and each copy
    indexes as its own row. Only the RUNNING install's copy is this backend's
    code; arming the others fires the same wizard once per copy (the 4×
    "Developer toolchain" rows). Ancestor form, as ``Wizard.is_shipped`` reads it.
    In an editable checkout the running install IS the repo, so it still arms.
    """
    if not asset_ref:
        return False
    from flow_sdk.config import is_running_install_path, is_system_project_path  # noqa: PLC0415

    ref = Path(asset_ref)
    if not any(is_system_project_path(p) for p in ref.parents):
        return False
    return not is_running_install_path(ref)


def trigger_runs_here(entity: Any) -> bool:
    """The location half of "may this row be armed here": not a foreign copy."""
    return not is_foreign_copy(str(getattr(entity, "asset_ref", "") or ""))


async def arm_trigger(entity: Any, *, replace: bool = False) -> None:
    """Subscribe this trigger to whatever fires it. Idempotent.

    Safe to call again on every re-index: ``register_tag_trigger``
    unregisters-then-registers, the FSOp arm is guarded on the watcher's task
    table, and a schedule job is replaced by id. ``replace=True`` (a create or
    an edit) restarts an FSOp watch even when one is running — its path or
    pattern may have changed.
    """
    from flow_sdk.schema.data_spec.trigger_types import TriggerType

    try:
        if not await runs_here(entity):   # every kind: another machine's place holds the file, never arms it
            await disarm_trigger(str(entity.id))
            return
        from flow_sdk.automations.lifecycle import on_arm  # noqa: PLC0415

        if not await on_arm(entity):  # ended: stays disarmed
            await disarm_trigger(str(entity.id))
            return
        if entity.trigger_type == TriggerType.SCHEDULE:
            await entity._register_schedule_job()
        elif entity.trigger_type == TriggerType.FSOP:
            # The watcher's startup walk covers a trigger seeded BEFORE it
            # starts; this covers one that arrives after.
            from flow_sdk.server.fsop_watcher import fsop_watcher  # noqa: PLC0415

            if replace or (len(fsop_watcher) and entity.id not in fsop_watcher._tasks):
                await fsop_watcher.on_trigger_saved(entity)
        elif entity.trigger_type == TriggerType.TAG:
            from flow_sdk.builtin.tag_triggers import register_tag_trigger  # noqa: PLC0415

            register_tag_trigger(entity)
            if getattr(entity, "awaits_reply", None):
                from flow_sdk.builtin.reply_callbacks import reconcile  # noqa: PLC0415

                await reconcile(entity)
    except Exception:
        # Never fail the save (or the index) over a subscription. The row is
        # committed either way, and the next re-index re-arms.
        _log.exception("Arming failed for trigger %r", getattr(entity, "uname", entity.id))


async def runs_here(entity: Any) -> bool:
    """Whether a trigger (of any kind) belongs to a place on THIS machine.

    ``runs_on`` names a Deployment. It runs here only if that Deployment is known
    here and ``is_local`` — a teammate's clone, or the desktop for a cloud
    machine's rule, holds the file but never arms it. No ``runs_on``: every machine that indexes it.
    """
    if not trigger_runs_here(entity):
        return False
    runs_on = str(getattr(entity, "runs_on", "") or "")
    if not runs_on:
        return True
    deployment = await deployment_named(runs_on)
    return bool(deployment is not None and deployment.is_local)


async def deployment_named(runs_on: str) -> Any:
    """The Deployment a ``runs_on`` names, as known here; None when it is unknown or unreadable."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    try:
        return await Deployment.get_by_id(runs_on)
    except Exception:  # noqa: BLE001 — unresolvable is "not here", never an error
        _log.debug("runs_on %s unresolvable", runs_on, exc_info=True)
        return None


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
    from flow_sdk.builtin.trigger import _project_setup_changed, set_trigger_on  # noqa: PLC0415

    # Flowpad's own follow their file, as they always did -- but one Flowpad ships off is the person's once decided; on a machine the hub runs ONLY for a deployed agent,
    # the deploy was its owner's choice, so recommended rules are on (nobody is at that box to answer setup).
    # Every other rule's switch is the person's here, and an index never moves it.
    if entity.is_builtin and not (entity.switchable and entity.decided):
        target = entity.recommended
    elif not entity.decided and entity.recommended and _deployed_agent_machine():
        target = True
    else:
        target = None
    if target is not None and (not entity.decided or entity.enabled != target):
        await set_trigger_on(entity, target)
        return
    if not entity.decided:  # a rule that came with a project: its setup now has something to ask
        _project_setup_changed(entity)
    await arm_trigger(entity)


async def rearm_missed_one_shot(trigger_id: str) -> None:
    """The scheduler dropped this one-shot as too late: arm it again, which runs it once now
    (``Trigger._register_schedule_job``)."""
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415

    try:
        trigger = await Trigger.get_by_id(trigger_id)
        if trigger is not None:
            await arm_trigger(trigger)
    except Exception:
        _log.exception("Could not re-arm missed one-shot %s", trigger_id)


async def disarm_trigger(trigger_id: str) -> None:
    """Unsubscribe a trigger whose asset is gone.

    The counterpart the index path needs and the seed path got from the orphan
    prune: deleting a trigger folder must not leave a live subscription behind,
    firing a callback whose declaration no longer exists.

    Every kind, not just TAG: a schedule job left in the persistent jobstore
    keeps waking on every tick until the next boot's orphan prune, and an FSOp
    watch keeps its awatch task. Each step is independent — the trigger may
    never have been armed as that kind, which is not an error.
    """
    try:
        from flow_sdk.builtin.tag_triggers import unregister_tag_trigger  # noqa: PLC0415

        unregister_tag_trigger(trigger_id)
    except Exception:
        _log.exception("Disarming (tag) failed for trigger %s", trigger_id)
    try:
        from flow_sdk.server.scheduler import get_scheduler  # noqa: PLC0415

        scheduler = get_scheduler()
        if scheduler is not None and scheduler.get_job(trigger_id) is not None:
            scheduler.remove_job(trigger_id)
    except Exception:
        _log.exception("Disarming (schedule) failed for trigger %s", trigger_id)
    try:
        from flow_sdk.server.fsop_watcher import fsop_watcher  # noqa: PLC0415

        await fsop_watcher.on_trigger_deleted(trigger_id)
    except Exception:
        _log.exception("Disarming (watch) failed for trigger %s", trigger_id)


def _deployed_agent_machine() -> bool:
    """This Flowpad runs only to serve a deployed agent (the hub assigned it the ``agent`` runtime)."""
    from flow_sdk.instance_settings.runtime import RuntimeKind, get_assigned_runtime  # noqa: PLC0415

    try:
        return get_assigned_runtime() == RuntimeKind.AGENT
    except Exception:  # noqa: BLE001 — unknown is "a person's machine": the safe answer
        return False
