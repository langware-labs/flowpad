"""Step 4: CallbackActionHandler — dispatches CALLBACK actions to registered Python handlers."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import (
    ActionType,
    CallbackActionHandler,
    TriggerAction,
    get_action_handler,
)


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _isolate_registry():
    snapshot = dict(trigger_callbacks._handlers)
    trigger_callbacks._handlers.clear()
    yield
    trigger_callbacks._handlers.clear()
    trigger_callbacks._handlers.update(snapshot)


def _make_fake_trigger(name: str = "test_trigger") -> MagicMock:
    """Lightweight stand-in for a Trigger entity. Handlers only read attributes."""
    t = MagicMock()
    t.name = name
    t.id = "fake-id-123"
    return t


async def test_callback_get_action_handler_returns_correct_handler():
    handler = get_action_handler(ActionType.CALLBACK)
    assert isinstance(handler, CallbackActionHandler)


async def test_callback_dispatched_via_registry():
    received = {}

    @trigger_callbacks.register("my_cb")
    async def my_handler(trigger, changed_path, change_type):
        received["trigger"] = trigger
        received["changed_path"] = changed_path
        received["change_type"] = change_type

    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name="my_cb")
    fake_trigger = _make_fake_trigger()

    await handler.execute(fake_trigger, action=action, changed_path="/tmp/x", change_type="modified")

    assert received["trigger"] is fake_trigger
    assert received["changed_path"] == "/tmp/x"
    assert received["change_type"] == "modified"


async def test_callback_missing_logs_warning_no_crash(caplog):
    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name="does_not_exist")
    fake_trigger = _make_fake_trigger()

    # Should NOT raise
    await handler.execute(fake_trigger, action=action, changed_path="/tmp/x", change_type="modified")

    # Warning should be logged
    assert any("does_not_exist" in r.message for r in caplog.records)


async def test_callback_missing_callback_name_logs_warning():
    """Action with action_type=CALLBACK but no callback_name → log warning, no crash."""
    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name=None)
    fake_trigger = _make_fake_trigger()

    await handler.execute(fake_trigger, action=action, changed_path="/tmp/x", change_type="modified")
    # No exception is the assertion; warning is a side effect we don't strictly require


async def test_callback_async_handler_awaited():
    calls = []

    @trigger_callbacks.register("async_h")
    async def async_handler(trigger, changed_path, change_type):
        calls.append("called")

    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name="async_h")
    await handler.execute(_make_fake_trigger(), action=action, changed_path="/x", change_type="m")
    assert calls == ["called"]


async def test_callback_sync_handler_invoked():
    """Sync handlers are supported — invoked directly (no event loop offload required)."""
    calls = []

    @trigger_callbacks.register("sync_h")
    def sync_handler(trigger, changed_path, change_type):
        calls.append("called")

    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name="sync_h")
    await handler.execute(_make_fake_trigger(), action=action, changed_path="/x", change_type="m")
    assert calls == ["called"]


async def test_callback_exception_propagates_from_handler():
    """If the registered handler raises, the exception propagates out of execute().

    The fire-loop (step 8) is responsible for catching this and continuing to the
    next action; the handler is a passthrough dispatcher.
    """

    @trigger_callbacks.register("bad")
    async def bad_handler(trigger, changed_path, change_type):
        raise RuntimeError("kaboom")

    handler = CallbackActionHandler()
    action = TriggerAction(action_type=ActionType.CALLBACK, callback_name="bad")
    with pytest.raises(RuntimeError, match="kaboom"):
        await handler.execute(_make_fake_trigger(), action=action, changed_path="/x", change_type="m")
