"""TAG triggers — Trigger entities as unified-bus subscriptions
(docs/flow-events.md phase 4).

A ``TriggerType.TAG`` trigger declares ``{tag_pattern, tag_target?,
tag_scope?}`` and fires through the SAME machinery as every other trigger
kind: counter/last_run update → ``trigger.fired`` emission → flow activation
(``on_trigger_fired``) → action dispatch via the handler registry →
trigger-log entry.

The log row carries the causing envelope as three lean scalars
(``cause_event_id`` / ``cause_tag`` / ``cause_target``) plus its OWN
``event_id``, not a full ``model_dump``. An earlier version of this module
passed ``event=event.model_dump()`` and claimed the row "embeds the full
envelope"; ``append_entry`` copies a fixed key set and silently dropped it, so
that was never true — see the note in ``fs_store/operations/trigger_log.py``.

Safety, because the bus has no budgets:

* **Self-loop brake** — the STRUCTURAL cycle guard, mirroring flow
  subscriptions (``graph_workflow_manager/manager.py``). A fire whose causing
  envelope already carries this trigger's own target in ``ctx.scope`` is
  dropped, which stops A→A and A→B→A. Cross-trigger chaining stays legal.
* **Storm guard** — a per-trigger fixed window (``max_fires_per_minute``,
  default 30). Exceeding it drops fires and records ONE suppression per window
  — never silent. Containment for volume; the brake above is what handles
  cycles.
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

from flow_sdk.tags import FixedWindowStormGuard, validate_bus_pattern

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.tags.envelope import FlowEvent

logger = logging.getLogger(__name__)

# trigger id → bus unsubscriber (one live subscription per TAG trigger).
_subscriptions: dict[str, Callable[[], None]] = {}
# trigger id → fire lock: fires for ONE trigger process sequentially, so the
# counter's read-modify-write can't lose updates under concurrent events and
# the storm window counts deterministically. Different triggers stay parallel.
_locks: dict[str, "asyncio.Lock"] = {}
# Per-trigger fire cap — the shared tags-owned guard shape.
_storm_guard = FixedWindowStormGuard()


def validate_tag_trigger(pattern: Optional[str]) -> Optional[str]:
    """The pointed pre-save check — delegates to the tags-owned grammar gate."""
    return validate_bus_pattern(pattern)


def register_tag_trigger(trigger: "Trigger") -> None:
    """Arm (or re-arm, replacing) the bus subscription for one TAG trigger."""
    from flow_sdk.tags import event_bus

    unregister_tag_trigger(trigger.id)
    if not trigger.enabled:
        return
    problem = validate_tag_trigger(trigger.tag_pattern)
    if problem:
        logger.warning("TAG trigger %s not armed: %s", trigger.name, problem)
        return
    trigger_id = trigger.id

    async def _handler(event: "FlowEvent") -> None:
        await _fire_tag_trigger(trigger_id, event)

    _subscriptions[trigger_id] = event_bus.on(
        trigger.tag_pattern,
        _handler,
        target=trigger.tag_target or None,
        scope=list(trigger.tag_scope) or None,
    )
    logger.info("TAG trigger %s armed: %s target=%s",
                trigger.name, trigger.tag_pattern, trigger.tag_target or "*")


def unregister_tag_trigger(trigger_id: Optional[str]) -> None:
    unsub = _subscriptions.pop(trigger_id or "", None)
    if unsub:
        unsub()
    _storm_guard.clear(trigger_id or "")
    _locks.pop(trigger_id or "", None)


async def start_tag_triggers() -> None:
    """Boot sweep: arm every enabled TAG trigger (fsop_watcher.start pattern)."""
    from flow_sdk.builtin.trigger import Trigger, TriggerType

    for trigger in await Trigger.list_by_type(TriggerType.TAG):
        try:
            register_tag_trigger(trigger)
        except Exception:
            logger.exception("TAG trigger %s: arming failed", trigger.name)


def _suppressed(trigger: "Trigger", reason_code: str, reason: str,
                cause: Optional["FlowEvent"] = None) -> None:
    """Record a declined fire on BOTH halves — the bus and the JSONL log.

    Every branch here was silent before: only the storm guard wrote a row, and
    a ``confirm`` rejection wrote nothing at all, which is why "I made a trigger
    and nothing happened" had no answer anywhere in the product.
    """
    from flow_sdk.builtin.trigger_on_tag import emit_trigger_suppressed

    trigger_id = trigger.id or ""
    name = trigger.name or trigger_id
    event_id = emit_trigger_suppressed(
        trigger_id, str(trigger.trigger_type), name,
        reason_code=reason_code, detail=reason,
        project_id=trigger.project_id, cause=cause,
    )
    _append_log(name, {
        "hook_event": "storm_suppressed" if reason_code == "storm" else "tag_suppressed",
        "trigger": False,
        "reason": reason,
        "reason_code": reason_code,
        "rule_name": name,
        "trigger_id": trigger_id,
        "trigger_type": str(trigger.trigger_type),
        "event_id": event_id,
        **_cause_keys(cause),
    })


def _cause_keys(cause: Optional["FlowEvent"]) -> dict[str, Any]:
    """The three lean scalars describing a causing envelope.

    Deliberately NOT ``cause.model_dump()``: a ``graph_workflow.*`` cause carries
    stdout/stderr tails (the reason ws_forward has MAX_RETAINED_DATA_CHARS), and
    1000 rows per rule would pin that to disk forever. ``cause_event_id`` is the
    pointer; look the envelope up if the full thing is ever wanted."""
    if cause is None:
        return {}
    return {
        "cause_event_id": cause.id,
        "cause_tag": cause.tag,
        "cause_target": cause.target,
        "actor": cause.ctx.actor,
    }


def _storm_allows(trigger: "Trigger", cap: int, cause: "FlowEvent") -> bool:
    """Fixed-window fire cap; records ONE suppression per window."""
    trigger_name = trigger.name or trigger.id or ""

    def _on_suppress() -> None:
        _suppressed(
            trigger, "storm",
            f"fires exceeded max_fires_per_minute={cap}; suppressing until the window resets",
            cause,
        )
        logger.warning("TAG trigger %s: storm guard tripped (cap %d/min)", trigger_name, cap)

    return _storm_guard.allows(trigger.id or "", cap, _on_suppress)


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
        logger.warning("TAG trigger %s: confirm type %r unknown — skipping fire",
                       trigger.name, ctype)
        return False
    rows = await entity_cls.get_all(dict(confirm.get("filter") or {}))
    return bool(rows)


async def _fire_tag_trigger(trigger_id: str, event: "FlowEvent") -> None:
    lock = _locks.setdefault(trigger_id, asyncio.Lock())
    async with lock:
        await _fire_tag_trigger_locked(trigger_id, event)


async def _fire_tag_trigger_locked(trigger_id: str, event: "FlowEvent") -> None:
    from flow_sdk.builtin.trigger import (
        Trigger,
        activate_flows_for_trigger,
        dispatch_trigger_actions,
    )

    from flow_sdk.builtin.trigger_on_tag import emit_trigger_fired
    from flow_sdk.tags.envelope import target_of

    trigger = await Trigger.get_by_id(trigger_id)
    if trigger is None:
        return  # deleted between arm and fire — nothing to attribute a row to
    if not trigger.enabled:
        _suppressed(trigger, "disabled",
                    "rule was disabled between arming and this event", event)
        return

    # SELF-LOOP BRAKE — mirrors the flow-subscription brake at
    # graph_workflow_manager/manager.py:372. Every `trigger.*` emission puts
    # `trigger:<id>` innermost in ctx.scope, and a tag fire PROPAGATES the
    # causing scope forward, so this kills A→A and A→B→A alike while leaving
    # cross-trigger chaining (A→B, no cycle) legal.
    #
    # Not optional once trigger.fired exists: `trigger.*` is a pattern a user
    # can save today, and without this the storm guard is the only thing
    # standing between them and a permanent 30-fires-per-minute loop — which is
    # containment, not correctness.
    if target_of("trigger", trigger_id) in event.ctx.scope:
        # Recorded, not merely logged: a self-loop drop is the most confusing
        # silent non-fire in the design — the rule looks armed, the event
        # matched, and nothing happened. That is exactly what the events screen
        # exists to explain, so it gets a row like every other declined fire.
        _suppressed(trigger, "self_loop",
                    f"{event.tag} already carries this rule in its scope chain "
                    f"— firing again would be a cycle", event)
        return

    if not _storm_allows(trigger, trigger.max_fires_per_minute, event):
        return
    if not await _confirmed(trigger):
        _suppressed(trigger, "confirm_failed",
                    f"confirm query on {(trigger.confirm or {}).get('type')} matched no rows",
                    event)
        return

    trigger.counter += 1
    trigger.last_run = datetime.now(timezone.utc)
    await trigger.update()

    # Emit BEFORE the work: `fired` means the rule matched and dispatch has
    # begun, not that it finished. What happens afterwards is `trigger.failed`.
    event_id = emit_trigger_fired(
        trigger_id, str(trigger.trigger_type), trigger.name or trigger_id,
        counter=trigger.counter,
        action_types=[str(a.action_type) for a in trigger.actions],
        detail={"cause_tag": event.tag, "cause_target": event.target},
        project_id=trigger.project_id,
        cause=event,
    )

    # Shared fire steps (same helpers as schedule/fsop). Tag fires carry no
    # file changes; the causing ENVELOPE rides through to the run entry, where
    # phase 7 preserves its id — so a run and this log row share one join key.
    await activate_flows_for_trigger(trigger_id, trigger.name or trigger_id,
                                     envelope=event, trigger=trigger)
    await dispatch_trigger_actions(trigger, changes=[])

    _append_log(trigger.name or trigger_id, {
        "hook_event": "tag_fire",
        "trigger": True,
        "reason": f"Tag {event.tag} on {event.target}",
        "rule_name": trigger.name,
        "trigger_id": trigger_id,
        "trigger_type": str(trigger.trigger_type),
        "event_id": event_id,
        **_cause_keys(event),
        "actions": [{"action_type": str(a.action_type)} for a in trigger.actions],
    })


def _append_log(trigger_name: str, entry: dict[str, Any]) -> None:
    try:
        from flow_sdk.fs_store.operations.trigger_log import append_entry

        append_entry(trigger_name, entry)
    except Exception:
        logger.debug("TAG trigger log append failed", exc_info=True)
