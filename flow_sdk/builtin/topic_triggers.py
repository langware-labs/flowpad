"""TOPIC triggers — Trigger entities as unified-bus subscriptions
(docs/flow-events.md phase 4).

A ``TriggerType.TOPIC`` trigger declares ``{topic_pattern, topic_target?,
topic_scope?}`` and fires through the SAME machinery as every other trigger
kind: counter/last_run update → flow activation (``on_trigger_fired``) →
action dispatch via the handler registry → trigger-log entry (which embeds
the full envelope — the phase-7 journal preview).

Safety, because the bus has no budgets:

* **Storm guard** — a per-trigger fixed window (``max_fires_per_minute``,
  default 30). Exceeding it drops fires and writes ONE ``storm_suppressed``
  log entry per window — never silent. This is also the structural cycle
  brake: a trigger whose actions re-emit its own pattern hits the bucket,
  not infinity.
* **Confirm-against-store (law 5)** — optional ``confirm: {type, filter}``;
  when set, the entity query must match or the fire is skipped (event says
  *check now*; the store says *it's true*).

Registration mirrors the schedule/fsop lifecycle: armed on create/update
(replacing any prior subscription — the APScheduler ``replace_existing``
idiom), torn down on delete/disable, and swept at boot next to
``fsop_watcher.start()``.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Optional

from flow_sdk.topics import FixedWindowStormGuard, validate_bus_pattern

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.topics.envelope import FlowEvent

logger = logging.getLogger(__name__)

# trigger id → bus unsubscriber (one live subscription per TOPIC trigger).
_subscriptions: dict[str, Callable[[], None]] = {}
# trigger id → fire lock: fires for ONE trigger process sequentially, so the
# counter's read-modify-write can't lose updates under concurrent events and
# the storm window counts deterministically. Different triggers stay parallel.
_locks: dict[str, "asyncio.Lock"] = {}
# Per-trigger fire cap — the shared topics-owned guard shape.
_storm_guard = FixedWindowStormGuard()


def validate_topic_trigger(pattern: Optional[str]) -> Optional[str]:
    """The pointed pre-save check — delegates to the topics-owned grammar gate."""
    return validate_bus_pattern(pattern)


def register_topic_trigger(trigger: "Trigger") -> None:
    """Arm (or re-arm, replacing) the bus subscription for one TOPIC trigger."""
    from flow_sdk.topics import event_bus

    unregister_topic_trigger(trigger.id)
    if not trigger.enabled:
        return
    problem = validate_topic_trigger(trigger.topic_pattern)
    if problem:
        logger.warning("TOPIC trigger %s not armed: %s", trigger.name, problem)
        return
    trigger_id = trigger.id

    async def _handler(event: "FlowEvent") -> None:
        await _fire_topic_trigger(trigger_id, event)

    _subscriptions[trigger_id] = event_bus.on(
        trigger.topic_pattern,
        _handler,
        target=trigger.topic_target or None,
        scope=list(trigger.topic_scope) or None,
    )
    logger.info("TOPIC trigger %s armed: %s target=%s",
                trigger.name, trigger.topic_pattern, trigger.topic_target or "*")


def unregister_topic_trigger(trigger_id: Optional[str]) -> None:
    unsub = _subscriptions.pop(trigger_id or "", None)
    if unsub:
        unsub()
    _storm_guard.clear(trigger_id or "")
    _locks.pop(trigger_id or "", None)


async def start_topic_triggers() -> None:
    """Boot sweep: arm every enabled TOPIC trigger (fsop_watcher.start pattern)."""
    from flow_sdk.builtin.trigger import Trigger, TriggerType

    for trigger in await Trigger.list_by_type(TriggerType.TOPIC):
        try:
            register_topic_trigger(trigger)
        except Exception:
            logger.exception("TOPIC trigger %s: arming failed", trigger.name)


def _storm_allows(trigger_id: str, trigger_name: str, cap: int) -> bool:
    """Fixed-window fire cap; logs ONE storm_suppressed entry per window."""

    def _on_suppress() -> None:
        _append_log(trigger_name, {
            "hook_event": "storm_suppressed",
            "trigger": False,
            "reason": f"fires exceeded max_fires_per_minute={cap}; suppressing until the window resets",
            "rule_name": trigger_name,
        })
        logger.warning("TOPIC trigger %s: storm guard tripped (cap %d/min)", trigger_name, cap)

    return _storm_guard.allows(trigger_id, cap, _on_suppress)


async def _confirmed(trigger: "Trigger") -> bool:
    """Law 5: when a confirm query is declared, the STORE decides.

    Conscious exception to the no-unscoped-get_all rule: this is a SYSTEM-level
    existence gate (fires run as the system, not a user request) and returns no
    row data to anyone — it only decides fire/skip. Scope-walking arrives with
    ctx.scope delivery authorization (phase 9)."""
    confirm = trigger.confirm or {}
    ctype = str(confirm.get("type") or "")
    if not ctype:
        return True
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(ctype)
    entity_cls = getattr(info, "entity_cls", None) if info else None
    if entity_cls is None:
        logger.warning("TOPIC trigger %s: confirm type %r unknown — skipping fire",
                       trigger.name, ctype)
        return False
    rows = await entity_cls.get_all(dict(confirm.get("filter") or {}))
    return bool(rows)


async def _fire_topic_trigger(trigger_id: str, event: "FlowEvent") -> None:
    lock = _locks.setdefault(trigger_id, asyncio.Lock())
    async with lock:
        await _fire_topic_trigger_locked(trigger_id, event)


async def _fire_topic_trigger_locked(trigger_id: str, event: "FlowEvent") -> None:
    from flow_sdk.builtin.trigger import (
        Trigger,
        activate_flows_for_trigger,
        dispatch_trigger_actions,
    )

    trigger = await Trigger.get_by_id(trigger_id)
    if not (trigger and trigger.enabled):
        return
    if not _storm_allows(trigger_id, trigger.name or trigger_id, trigger.max_fires_per_minute):
        return
    if not await _confirmed(trigger):
        return

    trigger.counter += 1
    trigger.last_run = datetime.now(timezone.utc)
    await trigger.update()

    # Shared fire steps (same helpers as schedule/fsop). Topic fires carry no
    # file changes; the ENVELOPE rides the log entry below (handlers gain an
    # event kwarg when one needs it).
    await activate_flows_for_trigger(trigger_id, trigger.name or trigger_id,
                                     envelope=event)
    await dispatch_trigger_actions(trigger, changes=[])

    _append_log(trigger.name or trigger_id, {
        "hook_event": "topic_fire",
        "trigger": True,
        "reason": f"Topic {event.topic} on {event.target}",
        "rule_name": trigger.name,
        "event": event.model_dump(),
        "actions": [{"action_type": str(a.action_type)} for a in trigger.actions],
    })


def _append_log(trigger_name: str, entry: dict[str, Any]) -> None:
    try:
        from flow_sdk.fs_store.operations.trigger_log import append_entry

        append_entry(trigger_name, entry)
    except Exception:
        logger.debug("TOPIC trigger log append failed", exc_info=True)
