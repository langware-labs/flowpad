"""Step 7: Action handler registry hooks — confirm get_action_handler resolves
all four ActionType values to the correct handler instances.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.hook_models import (
    ActionType,
    CallbackActionHandler,
    NopActionHandler,
    NotifyEntityActionHandler,
    RunScriptActionHandler,
    get_action_handler,
)


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def test_nop_handler_registered():
    assert isinstance(get_action_handler(ActionType.NOP), NopActionHandler)


def test_notify_entity_handler_registered():
    assert isinstance(get_action_handler(ActionType.NOTIFY_ENTITY), NotifyEntityActionHandler)


def test_run_script_handler_registered():
    assert isinstance(get_action_handler(ActionType.RUN_SCRIPT), RunScriptActionHandler)


def test_callback_handler_registered():
    assert isinstance(get_action_handler(ActionType.CALLBACK), CallbackActionHandler)


def test_unknown_action_type_returns_none():
    """ActionType is a closed StrEnum but an out-of-band string should return None."""

    class _Fake:
        value = "doesnt_exist"

    # get_action_handler uses dict.get(), so unknown returns None
    assert get_action_handler(_Fake()) is None  # type: ignore[arg-type]


def test_all_action_types_have_handlers():
    """Every value in ActionType must have a registered handler."""
    for at in ActionType:
        handler = get_action_handler(at)
        assert handler is not None, f"{at} has no registered handler"
