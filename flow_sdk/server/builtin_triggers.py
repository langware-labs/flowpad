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
from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.instance_settings import get_instance_settings

_log = logging.getLogger(__name__)


# ── Built-in callbacks ───────────────────────────────────────────────────────


@trigger_callbacks.register(
    "builtin_toplog_filter_apply",
    meaning="Fired when the per-instance toplog.json filter changes. "
            "Re-applies log level/disabled flags to topic loggers and broadcasts "
            "the new state to UI clients. Stub while toplog Slice A is parked — "
            "the trigger's counter still increments on every fire.",
)
async def _toplog_filter_apply(trigger: Trigger, changed_path: Any, change_type: Any) -> None:
    # When toplog Slice A lands, this re-reads the filter and applies it to
    # `logging.getLogger("toplog.*")` + broadcasts over WS. Until then the fire
    # path itself (counter bump → entity update → WS) is the demonstration surface.
    _log.info(
        "builtin_toplog_filter_apply: %s changed (%s); toplog Slice A parked",
        changed_path, change_type,
    )


# ── Spec list ────────────────────────────────────────────────────────────────


def _service_trigger_specs() -> list[dict[str, Any]]:
    """Canonical system FSOp triggers. Resolved lazily so test fixtures that
    monkeypatch `get_instance_settings()` get the redirected paths."""
    # Import here so the route callback's @trigger_callbacks.register decorator
    # runs before set_service_triggers does — guarantees the callback is in
    # the registry when the watcher dispatches its first event.
    from flow_sdk.transcript_streamer.triggers import transcript_watcher_trigger_specs

    settings = get_instance_settings()
    specs: list[dict[str, Any]] = [
        dict(
            uname="builtin_toplog_watcher",
            name="Toplog filter watcher",
            description="Watches the per-instance toplog.json; re-applies the "
                        "filter to topic loggers and broadcasts to UI.",
            trigger_type=TriggerType.FSOP,
            watch_path=str(settings.toplog_config_path),
            recursive=False,
            actions=[TriggerAction(
                action_type=ActionType.CALLBACK,
                callback_name="builtin_toplog_filter_apply",
            )],
        ),
    ]
    specs.extend(transcript_watcher_trigger_specs(settings))
    return specs


# ── Upsert ───────────────────────────────────────────────────────────────────


async def _upsert_one(spec: dict[str, Any]) -> None:
    """Find-by-uname, then update-or-create. Idempotent across server restarts."""
    uname = spec["uname"]
    try:
        existing = await Trigger.get_by_uname(uname)
    except Exception:
        existing = None

    if existing is None:
        try:
            await Trigger(**spec).save()
            _log.info("Created builtin trigger %r", uname)
        except Exception:
            _log.exception("Failed to create builtin trigger %r", uname)
        return

    # Update mutable fields in case the spec changed across restarts.
    for key in ("name", "description", "trigger_type", "watch_path", "recursive", "actions"):
        setattr(existing, key, spec[key])
    try:
        await existing.update()
        _log.info("Updated builtin trigger %r", uname)
    except Exception:
        _log.exception("Failed to update builtin trigger %r", uname)


async def set_service_triggers() -> None:
    """Idempotently upsert system FSOp triggers, then seed any missing
    watched files so `awatch` has something to subscribe to on first boot.

    Called from `_on_server_startup` BEFORE `fsop_watcher.start()`.
    """
    for spec in _service_trigger_specs():
        await _upsert_one(spec)

    # Seed any missing watched files so awatch attaches cleanly on boot.
    settings = get_instance_settings()
    if not settings.toplog_config_path.exists():
        try:
            settings.toplog_config_path.parent.mkdir(parents=True, exist_ok=True)
            settings.toplog_config_path.write_text('{"filter":{}}\n')
        except Exception:
            _log.exception("Failed to seed initial toplog.json")
