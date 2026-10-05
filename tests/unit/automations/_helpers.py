"""Shared helpers for the Automations tests: build rules, drain background work, read history."""

from __future__ import annotations

import asyncio
from typing import Any

from flow_sdk.builtin.trigger import Trigger
from flow_sdk.schema.data_spec.trigger_types import TriggerType

#: Drain rounds before we call it a runaway — bounds handler-emits-handler
#: recursion and FAILS when hit; not a time budget.
_MAX_DRAIN_ROUNDS = 50


async def settle() -> None:
    """Await every task the bus, a test run, or a tag fire scheduled — never a sleep."""
    from flow_sdk.automations import run_once
    from flow_sdk.tags.bus import _INFLIGHT

    current = asyncio.current_task()
    for _ in range(_MAX_DRAIN_ROUNDS):
        pending = [
            t for t in (*_INFLIGHT, *run_once._inflight)
            if t is not current and not t.done()
        ]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)
    raise AssertionError("background work never went quiet")


def rule(kind: TriggerType, **kw: Any) -> Trigger:
    """An unsaved Trigger of ``kind`` with a unique name (history is filed by name)."""
    import uuid

    defaults: dict[str, Any] = dict(name=f"auto-{kind.value}-{uuid.uuid4().hex[:8]}",
                                    trigger_type=kind, scope="user")
    if kind == TriggerType.TAG:
        defaults["tag_pattern"] = "drill.*"
    if kind == TriggerType.SCHEDULE:
        defaults.update(expr="0 9 * * 1-5", sched_trigger_type="cron")
    defaults.update(kw)
    return Trigger(**defaults)


def history(trigger: Trigger) -> list[dict[str, Any]]:
    """This rule's log rows, OLDEST first."""
    from flow_sdk.fs_store.operations.trigger_log import discover

    return list(reversed(discover(trigger.name, limit=100)))
