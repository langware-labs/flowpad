"""Built-in system triggers: upserted at server boot.

`set_service_triggers()` is called from `_on_server_startup` before
`fsop_watcher.start()` so the watcher's startup walk finds them and spawns
awatch tasks. Triggers carry `scope='system'` (default for Trigger entities)
and live in the entity store keyed by `uname`.

Adding a new system trigger:
  1. Add an entry to `_service_trigger_specs()`.
  2. Register its `@trigger_callbacks.register(...)` handler below.
"""
from __future__ import annotations

import logging
from typing import Any

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.instance_settings import get_instance_settings

_log = logging.getLogger(__name__)


# ── Built-in callbacks ───────────────────────────────────────────────────────


@trigger_callbacks.register(
    "builtin_toplog_filter_apply",
    meaning="Fired when the per-instance toplog.json changes. Re-derives the "
            "in-memory tag state from the file and broadcasts the new state to "
            "all UI clients. This is the single broadcaster for toplog — every "
            "writer (backend, frontend-via-route, worker, human edit) converges "
            "through the file and this callback.",
)
async def _toplog_filter_apply(trigger: Trigger, changes: list[ChangeEvent]) -> None:
    # The file is authority: re-derive this process's in-memory state, then push
    # it to every connected client. Runs in the server's async context, so it is
    # the one place allowed to await broadcast(); the sync toplog mutators never
    # touch the event loop.
    from flow_sdk import toplog

    toplog._apply_from_file()
    try:
        from flow_sdk.api.messages import ToplogStateMessage
        from flow_sdk.server.routes.websocket import broadcast

        st = toplog.state()
        await broadcast(
            ToplogStateMessage(enabled=st["enabled"], filter=st["filter"]).model_dump_json()
        )
    except Exception:
        _log.exception("toplog: failed to broadcast state after file change")


# ── Spec list ────────────────────────────────────────────────────────────────


def _service_trigger_specs() -> list[dict[str, Any]]:
    """Canonical system triggers. Resolved lazily so test fixtures that
    monkeypatch `get_instance_settings()` get the redirected paths.

    The imports below are intentionally lazy — they exist so each consumer's
    ``@trigger_callbacks.register`` decorator runs before set_service_triggers
    upserts the trigger, guaranteeing the callback is in the registry when
    the first fire dispatches.
    """
    from flow_sdk.server import system_heartbeat as _heartbeat  # noqa: F401  decorator side-effect
    from flow_sdk.transcript_streamer.triggers import transcript_watcher_trigger_specs
    from flow_sdk.usage_report import callback as _usage_report_cb  # noqa: F401  decorator side-effect

    settings = get_instance_settings()
    specs: list[dict[str, Any]] = [
        dict(
            uname="builtin_toplog_watcher",
            name="Toplog filter watcher",
            description="Watches the per-instance toplog.json; re-applies the "
                        "filter to tag loggers and broadcasts to UI.",
            trigger_type=TriggerType.FSOP,
            watch_path=str(settings.toplog_config_path),
            recursive=False,
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_toplog_filter_apply",
            )],
        ),
        dict(
            uname="builtin_daily_usage_analysis",
            name="Last day usage analysis",
            description="Every day at 7am (local): fires the daily-analysis "
                        "flow — analyze (function) → publish — which posts a usage "
                        "report to the Home Feed. Manually runnable like any trigger.",
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type="cron",
            expr="0 7 * * *",
            # No direct action: the daily-analysis GraphWorkflow (service_graph_workflows)
            # routes this trigger's `fired` through analyze → publish —
            # a direct action here would double-fire the report.
            actions=[],
        ),
        dict(
            uname="builtin_system_heartbeat",
            name="System heartbeat",
            description="Fires every minute. Housekeeping tasks register via "
                        "@register_heartbeat_task; the dispatch callback fans "
                        "out and isolates per-task failures.",
            trigger_type=TriggerType.SCHEDULE,
            sched_trigger_type="cron",
            expr="* * * * *",
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_heartbeat_dispatch",
            )],
        ),
    ]
    specs.extend(transcript_watcher_trigger_specs(settings))
    return specs


# ── Upsert ───────────────────────────────────────────────────────────────────


# Fields that aren't user-mutable post-save and shouldn't be re-applied on
# upsert. ``uname`` is the identity key; counter/last_triggered/last_run are
# runtime state we never want to clobber from a static spec.
_UPSERT_SKIP_KEYS = frozenset({"uname", "counter", "last_triggered", "last_run", "next_run"})


async def _upsert_one(spec: dict[str, Any]) -> None:
    """Find-by-uname, then update-or-create. Idempotent across server restarts.

    On create, also runs the trigger-type's post-save registration so the
    watcher / scheduler picks it up immediately (without waiting for the
    next server boot). On update, leaves the watcher/scheduler entry in
    place — the fields it cares about (cron expr, watch_path, etc.) only
    matter at registration time anyway.
    """
    uname = spec["uname"]
    try:
        existing = await Trigger.get_by_uname(uname)
    except Exception:
        existing = None

    if existing is None:
        try:
            entity = Trigger(**spec)
            await entity.save()
            await _register_post_save(entity)
            _log.info("Created builtin trigger %r", uname)
        except Exception:
            _log.exception("Failed to create builtin trigger %r", uname)
        return

    # Update every spec field except identity/runtime — generic so any
    # trigger type (HOOK/SCHEDULE/FSOP) updates correctly across restarts.
    for key, value in spec.items():
        if key in _UPSERT_SKIP_KEYS:
            continue
        setattr(existing, key, value)
    try:
        await existing.update()
        # SCHEDULE: re-register in case the cron expression changed across
        # restarts. APScheduler's add_job(replace_existing=True) is idempotent.
        await _register_post_save(existing)
        _log.info("Updated builtin trigger %r", uname)
    except Exception:
        _log.exception("Failed to update builtin trigger %r", uname)


async def _register_post_save(entity: Trigger) -> None:
    """Mirror the post-save registration step that the public create_action
    route runs (`flow_sdk/builtin/trigger.py:432`) — needed because the entity
    save alone doesn't tell APScheduler / the FSOp watcher about the trigger."""
    try:
        if entity.trigger_type == TriggerType.SCHEDULE:
            await entity._register_schedule_job()
        elif entity.trigger_type == TriggerType.FSOP:
            # FSOp triggers are picked up by the watcher's startup walk
            # (set_service_triggers runs BEFORE fsop_watcher.start), so we
            # don't need to spawn the awatch task here — the boot order
            # covers it. Future-proof against re-ordering with an explicit
            # call once the watcher is running:
            from flow_sdk.server.fsop_watcher import fsop_watcher
            if len(fsop_watcher) and entity.id not in fsop_watcher._tasks:
                await fsop_watcher.on_trigger_saved(entity)
    except Exception:
        _log.exception("Post-save registration failed for trigger %r", entity.uname)


async def set_service_triggers() -> None:
    """Idempotently upsert system FSOp triggers, then seed any missing
    watched files so `awatch` has something to subscribe to on first boot.

    Called from `_on_server_startup` BEFORE `fsop_watcher.start()`.
    """
    for spec in _service_trigger_specs():
        await _upsert_one(spec)

    # Seed the watched toplog.json so awatch attaches cleanly on boot. The master
    # switch is seeded from the instance setting (on in dev, off in prod); after
    # this the file is authority. The seed write happens BEFORE fsop_watcher.start(),
    # so no trigger fires for it — seed_file also re-derives the in-memory state so
    # the dev/prod default takes effect immediately on first boot.
    settings = get_instance_settings()
    try:
        from flow_sdk import toplog
        toplog.seed_file(settings.toplog_enabled)
    except Exception:
        _log.exception("Failed to seed/apply initial toplog state")
