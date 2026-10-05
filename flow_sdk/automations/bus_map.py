"""The event bus as a map: every event type, how often it happened, who listens, what they do.

Three sources joined in memory: the shipped vocabulary (``SYSTEM_TAG_SEED`` —
titles and descriptions), what the bus has seen since boot (``observed_tags`` —
counts), and every event automation (``Trigger`` rows of kind tag — listeners).
A listener whose pattern no known event matches still appears, as its own
pattern, so a rule waiting on an event that never happened is visible.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.schema.data_spec.automation_spec import BusEventType, BusListener, BusMap


async def bus_map() -> BusMap:
    from flow_sdk.automations.describe import _Names, describe_then, event_catalog  # noqa: PLC0415
    from flow_sdk.automations.overview import group_of  # noqa: PLC0415
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.builtin.trigger_arming import is_foreign_copy  # noqa: PLC0415
    from flow_sdk.schema.data_spec.trigger_types import TriggerType  # noqa: PLC0415
    from flow_sdk.tags import event_bus  # noqa: PLC0415
    from flow_sdk.tags.bus import explain_subscription_match  # noqa: PLC0415
    from flow_sdk.tags.grammar import tag_matches  # noqa: PLC0415
    from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS  # noqa: PLC0415

    catalog = event_catalog()
    observed: dict[str, Any] = event_bus.observed_tags()
    names = set(catalog) | set(observed)
    families = {n for n in names if any(other.startswith(n + ".") for other in names)}

    names_cache = _Names()
    listeners: list[BusListener] = []
    for trigger in await Trigger.list_by_type(TriggerType.TAG):
        if not trigger.tag_pattern:
            continue
        listeners.append(BusListener(
            id=str(trigger.id), name=trigger.name or "", pattern=trigger.tag_pattern,
            enabled=bool(trigger.enabled), group=group_of(trigger),
            active=not is_foreign_copy(trigger.asset_ref),
            then=await describe_then(trigger, names=names_cache),
        ))

    def _listening(name: str) -> list[BusListener]:
        return [lst for lst in listeners if explain_subscription_match(lst.pattern, name, "")["tag"]]

    out: list[BusEventType] = []
    matched_patterns: set[str] = set()
    for name in sorted(names):
        title, description = catalog.get(name, ("", ""))
        stat = observed.get(name) or {}
        here = [] if name in families else _listening(name)
        matched_patterns.update(lst.pattern for lst in here)
        out.append(BusEventType(
            name=name, title=title, description=description, family=name in families,
            count=int(stat.get("count") or 0), last_ts=stat.get("last_ts"), last_target=stat.get("last_target"),
            forwarded=any(tag_matches(p, name) for p in FORWARDED_TAG_PATTERNS),
            listeners=here,
        ))
    for pattern in sorted({lst.pattern for lst in listeners} - matched_patterns):
        out.append(BusEventType(name=pattern, pattern_only=True,
                                listeners=[lst for lst in listeners if lst.pattern == pattern]))
    return BusMap(event_types=out, forwarded_patterns=list(FORWARDED_TAG_PATTERNS))
