"""Overlapping deliveries are skipped, never logged as completed work."""

import asyncio
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.change_event import ChangeEvent
from flow_sdk.builtin.trigger import Trigger, run_schedule_fire
from flow_sdk.schema.data_spec.trigger_action import ActionType, TriggerAction
from flow_sdk.server.fsop_watcher import _fire


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["schedule", "fsop"])
async def test_busy_delivery_has_no_acceptance_effects_and_skipped_history(kind, monkeypatch, initialize_test_db):
    from flow_sdk.automations.runs import fold
    from flow_sdk.builtin import trigger_on_tag
    from flow_sdk.fs_store.operations import trigger_log

    entered, release = asyncio.Event(), asyncio.Event()
    rows, fired, effects = [], [], []
    name = f"busy-{mint_uuid()}"

    @trigger_callbacks.register(name)
    async def hold(trigger, changes):
        effects.append(trigger.id)
        entered.set()
        await release.wait()

    monkeypatch.setattr(trigger_log, "append_entry", lambda name, row: rows.append(row))
    monkeypatch.setattr(trigger_on_tag, "emit_trigger_fired", lambda *a, **kw: fired.append(kw))
    trigger = Trigger(name=name, trigger_type=kind, enabled=True, expr="0 * * * *",
                      actions=[TriggerAction(action_type=ActionType.CALLBACK, callback_name=name)])
    trigger.id = str(mint_uuid())

    async def deliver(is_test):
        if kind == "schedule":
            await run_schedule_fire(trigger, None, is_test=is_test)
        else:
            await _fire(trigger, [ChangeEvent(path=Path("/tmp/busy-test"), change_type="modified")], is_test=is_test)

    first = asyncio.create_task(deliver(True))
    try:
        await entered.wait()
        await deliver(False)
        assert effects == [trigger.id]
        assert trigger.counter == 0 and trigger.last_triggered is None
        assert fired == []
        assert len(rows) == 1 and rows[0]["trigger"] is False
        assert rows[0]["reason_code"] == "busy"
        assert fold(rows)[0].status == "skipped"
        assert rows[0]["wizard"]["steps"] == {}
        assert rows[0]["wizard"]["invocation_id"] == rows[0]["id"]
    finally:
        release.set()
        await first
        trigger_callbacks._handlers.pop(name, None)
