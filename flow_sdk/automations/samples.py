"""Real recent events to test an event automation with.

Two sources, best first. An ARMED rule remembers the last envelopes that matched
it (``tag_triggers.recent_matches``) — exact, and covers any tag. A rule that is
off or not saved yet has no subscription, so it can only be offered what the app
was forwarded (``ws_forward.recent_events``): the bus keeps no history of its
own, so a tag outside the forwarded families has nothing to offer until it
happens again — the screen then says "Wait for the next one".
"""

from __future__ import annotations

from typing import Any, Optional

#: How many samples the test panel offers.
SAMPLE_LIMIT = 5


def _sample(envelope: dict[str, Any]) -> dict[str, Any]:
    """The fields a test run needs, plus what the picker shows."""
    return {
        "id": envelope.get("id"),
        "ts": envelope.get("timestamp") or envelope.get("ts"),
        "tag": envelope.get("tag"),
        "target": envelope.get("target"),
        "data": envelope.get("data") or {},
    }


def forwarded_matching(pattern: str, target_filter: Optional[str] = None,
                       limit: int = SAMPLE_LIMIT) -> list[dict[str, Any]]:
    """Recent forwarded envelopes the pattern (and target filter) would receive, newest first."""
    from flow_sdk.tags.bus import explain_subscription_match  # noqa: PLC0415
    from flow_sdk.tags.ws_forward import recent_events  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    for envelope in reversed(recent_events()):
        parts = explain_subscription_match(pattern, str(envelope.get("tag") or ""), str(envelope.get("target") or ""),
                                           target_filter=target_filter or None)
        if parts["tag"] and parts["target"]:
            out.append(_sample(envelope))
            if len(out) >= limit:
                break
    return out


def samples_for(trigger: Any, limit: int = SAMPLE_LIMIT) -> list[dict[str, Any]]:
    """What this event automation could be tested with, newest first."""
    from flow_sdk.builtin.tag_triggers import recent_matches  # noqa: PLC0415

    remembered = [_sample(e) for e in recent_matches(str(trigger.id or ""))][:limit]
    if remembered:
        return remembered
    if not trigger.tag_pattern:
        return []
    return forwarded_matching(str(trigger.tag_pattern), trigger.tag_target, limit)
