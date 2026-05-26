"""Step 2: Entity field additions + actions list migration.

Verifies:
- New FSOp fields on Trigger (watch_path, recursive, watch_glob, last_seen_*).
- New per-action fields on TriggerAction (script_path, script_filename, callback_name).
- `action: TriggerAction` migrated to `actions: list[TriggerAction]`.
- Legacy singular-action input still loads (wrapped into a single-element list).
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.hook_models import ActionType, TriggerAction
from flow_sdk.builtin.trigger import Trigger, TriggerType


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


# ── New fields on Trigger ────────────────────────────────────────────────────


def test_watch_path_field_default_none():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP)
    assert t.watch_path is None


def test_watch_path_can_be_set():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP, watch_path="/tmp/x")
    assert t.watch_path == "/tmp/x"


def test_recursive_field_default_false():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP)
    assert t.recursive is False


def test_watch_glob_field_default_none():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP)
    assert t.watch_glob is None


def test_last_seen_mtime_default_none():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP)
    assert t.last_seen_mtime is None


def test_last_seen_size_default_none():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP)
    assert t.last_seen_size is None


def test_last_seen_mtime_can_be_set():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP, last_seen_mtime=1234567890.5)
    assert t.last_seen_mtime == 1234567890.5


def test_last_seen_size_can_be_set():
    t = Trigger(name="t", trigger_type=TriggerType.FSOP, last_seen_size=4096)
    assert t.last_seen_size == 4096


# ── New fields on TriggerAction ──────────────────────────────────────────────


def test_trigger_action_script_path_default_none():
    a = TriggerAction(action_type=ActionType.RUN_SCRIPT)
    assert a.script_path is None


def test_trigger_action_script_filename_default_none():
    a = TriggerAction(action_type=ActionType.RUN_SCRIPT)
    assert a.script_filename is None


def test_trigger_action_callback_name_default_none():
    a = TriggerAction(action_type=ActionType.CALLBACK)
    assert a.callback_name is None


def test_trigger_action_script_path_can_be_set():
    a = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path="/x/y.sh")
    assert a.script_path == "/x/y.sh"


def test_trigger_action_script_filename_can_be_set():
    a = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_filename="script.sh")
    assert a.script_filename == "script.sh"


def test_trigger_action_callback_name_can_be_set():
    a = TriggerAction(action_type=ActionType.CALLBACK, callback_name="my_handler")
    assert a.callback_name == "my_handler"


# ── actions: list[...] migration ─────────────────────────────────────────────


def test_actions_default_is_empty_list():
    """A fresh Trigger has no actions until configured."""
    t = Trigger(name="t")
    assert t.actions == []


def test_actions_can_be_set():
    a1 = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path="/a.sh")
    a2 = TriggerAction(action_type=ActionType.CALLBACK, callback_name="cb")
    t = Trigger(name="t", actions=[a1, a2])
    assert len(t.actions) == 2
    assert t.actions[0].action_type == ActionType.RUN_SCRIPT
    assert t.actions[1].action_type == ActionType.CALLBACK


def test_legacy_singular_action_wrapped_into_list():
    """Records persisted with `action: {...}` (no list) load as actions=[that_one]."""
    legacy = TriggerAction(action_type=ActionType.NOP)
    t = Trigger(name="t", action=legacy)
    assert len(t.actions) == 1
    assert t.actions[0].action_type == ActionType.NOP


def test_legacy_singular_action_via_dict():
    """The legacy load path also handles raw dict input (from JSON load)."""
    t = Trigger(name="t", action={"action_type": "nop"})
    assert len(t.actions) == 1
    assert t.actions[0].action_type == ActionType.NOP


def test_actions_takes_precedence_over_legacy_action():
    """If both `action` and `actions` are given, `actions` wins."""
    legacy = TriggerAction(action_type=ActionType.NOP)
    new = [TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path="/x.sh")]
    t = Trigger(name="t", action=legacy, actions=new)
    assert len(t.actions) == 1
    assert t.actions[0].action_type == ActionType.RUN_SCRIPT


def test_action_property_returns_first_action():
    """Code reading `trigger.action` (legacy) still gets actions[0] for compat."""
    a = TriggerAction(action_type=ActionType.RUN_SCRIPT, script_path="/x.sh")
    t = Trigger(name="t", actions=[a])
    # `trigger.action` should expose the first action
    assert t.action.action_type == ActionType.RUN_SCRIPT
    assert t.action.script_path == "/x.sh"


def test_existing_schedule_trigger_legacy_action_default_preserved():
    """Schedule triggers created without explicit actions still have a NOP `action`
    field (the legacy default), so existing dispatch code at trigger.py:230 keeps
    working. New `actions` list stays empty until configured."""
    t = Trigger(name="t", trigger_type=TriggerType.SCHEDULE, expr="*/5 * * * *")
    assert t.action.action_type == ActionType.NOP
    assert t.actions == []
