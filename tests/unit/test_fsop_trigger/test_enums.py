"""Step 1: TriggerType + extended ActionType enums.

TDD red phase first — these tests fail until the enums are defined.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.hook_models import ActionType
from flow_sdk.builtin.trigger import Trigger, TriggerType


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def test_trigger_type_values():
    assert TriggerType.HOOK.value == "hook"
    assert TriggerType.SCHEDULE.value == "schedule"
    assert TriggerType.FSOP.value == "fsop"


def test_action_type_values():
    assert ActionType.NOP.value == "nop"
    assert ActionType.NOTIFY_ENTITY.value == "notify_entity"
    assert ActionType.RUN_SCRIPT.value == "run_script"
    assert ActionType.CALLBACK.value == "callback"


def test_trigger_type_string_load_hook():
    t = Trigger(name="t", trigger_type="hook")
    assert t.trigger_type == TriggerType.HOOK
    assert t.trigger_type == "hook"  # StrEnum value equality


def test_trigger_type_string_load_schedule():
    t = Trigger(name="t", trigger_type="schedule")
    assert t.trigger_type == TriggerType.SCHEDULE


def test_trigger_type_string_load_fsop():
    t = Trigger(name="t", trigger_type="fsop")
    assert t.trigger_type == TriggerType.FSOP


def test_invalid_trigger_type_rejected():
    with pytest.raises(Exception):  # pydantic ValidationError or ValueError
        Trigger(name="t", trigger_type="garbage")


def test_trigger_type_default_is_hook():
    t = Trigger(name="t")
    assert t.trigger_type == TriggerType.HOOK
