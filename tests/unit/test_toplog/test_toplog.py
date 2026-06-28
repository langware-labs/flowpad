"""Unit tests for toplog — topic-based runtime logging (flow_sdk/toplog.py).

The file is authority; the in-memory state is always derived from it. These
tests drive the file synchronously (no awatch, no sleep) and assert the derived
state + the `logging.getLogger("toplog")` emissions.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from flow_sdk import toplog
from flow_sdk.builtin.change_event import ChangeEvent

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


@pytest.fixture(autouse=True)
def _toplog_file(tmp_path: Path, monkeypatch):
    """Redirect toplog's config path into a temp file and reset module state."""
    path = tmp_path / "toplog.json"
    monkeypatch.setattr(toplog, "_config_path", lambda: path)
    toplog._active_topics.clear()
    monkeypatch.setattr(toplog, "_enabled", False, raising=False)
    toplog._apply_from_file()  # derive from the (missing) file → all off
    yield path


def _read(path: Path) -> dict:
    return json.loads(path.read_text())


# ── defaults ─────────────────────────────────────────────────────────────────


def test_default_everything_off(_toplog_file):
    assert toplog.is_enabled() is False
    assert toplog.active_topics() == set()
    assert toplog.is_on("pty") is False


def test_log_is_noop_when_disabled(_toplog_file, caplog):
    caplog.set_level(logging.INFO, logger="toplog")
    toplog.on("pty")  # topic on, but master switch still off
    toplog.log("pty", "should not emit")
    assert caplog.records == []


# ── on / off round-trips through the file ────────────────────────────────────


def test_on_writes_file_and_derives_state(_toplog_file):
    toplog.enable()
    toplog.on("pty")
    assert _read(_toplog_file) == {"enabled": True, "filter": {"pty": True}}
    assert toplog.is_on("pty") is True


def test_off_removes_topic(_toplog_file):
    toplog.enable()
    toplog.on("pty", "sync")
    toplog.off("pty")
    assert toplog.is_on("pty") is False
    assert toplog.is_on("sync") is True
    assert "pty" not in _read(_toplog_file)["filter"]


def test_log_emits_when_topic_active(_toplog_file, caplog):
    caplog.set_level(logging.INFO, logger="toplog")
    toplog.enable()
    toplog.on("pty")
    toplog.log("pty", "hello %s", "world")
    assert len(caplog.records) == 1
    assert caplog.records[0].getMessage() == "[pty] hello world"


# ── OR semantics ─────────────────────────────────────────────────────────────


def test_or_semantics_any_active_emits(_toplog_file, caplog):
    caplog.set_level(logging.INFO, logger="toplog")
    toplog.enable()
    toplog.on("sync")  # only one of the two listed topics is on
    toplog.log(["pty", "sync"], "multi")
    assert len(caplog.records) == 1
    # Only the active topic(s) are in the prefix.
    assert caplog.records[0].getMessage() == "[sync] multi"


def test_or_semantics_none_active_noop(_toplog_file, caplog):
    caplog.set_level(logging.INFO, logger="toplog")
    toplog.enable()
    toplog.on("other")
    toplog.log(["pty", "sync"], "multi")
    assert caplog.records == []


# ── master switch ────────────────────────────────────────────────────────────


def test_disable_gates_everything(_toplog_file, caplog):
    caplog.set_level(logging.INFO, logger="toplog")
    toplog.enable()
    toplog.on("pty")
    toplog.disable()
    assert toplog.is_on("pty") is False
    toplog.log("pty", "nope")
    assert caplog.records == []
    # Re-enabling restores the still-present topic.
    toplog.enable()
    assert toplog.is_on("pty") is True


# ── merge / tolerance ────────────────────────────────────────────────────────


def test_merge_does_not_clobber_other_topics(_toplog_file):
    toplog.enable()
    toplog.on("a")
    toplog.on("b")  # second write must not drop "a"
    flt = _read(_toplog_file)["filter"]
    assert flt == {"a": True, "b": True}


def test_enable_preserves_existing_filter(_toplog_file):
    toplog.on("a")  # written while disabled
    toplog.enable()
    assert _read(_toplog_file) == {"enabled": True, "filter": {"a": True}}


def test_tolerant_read_of_corrupt_file(_toplog_file):
    _toplog_file.write_text("{not json")
    toplog._apply_from_file()  # must not raise
    assert toplog.is_enabled() is False
    assert toplog.active_topics() == set()
    # A subsequent mutate recovers to a valid shape.
    toplog.enable()
    assert _read(_toplog_file)["enabled"] is True


def test_external_edit_picked_up_by_apply(_toplog_file):
    _toplog_file.write_text(json.dumps({"enabled": True, "filter": {"x": True}}))
    toplog._apply_from_file()
    assert toplog.is_on("x") is True


# ── trigger callback (the broadcaster) ───────────────────────────────────────


async def test_trigger_callback_reapplies_from_file(_toplog_file):
    """The FSOp callback re-derives state from the file. Called directly (no
    awatch, no sleep), mirroring the existing trigger tests."""
    from flow_sdk.server.builtin_triggers import _toplog_filter_apply

    _toplog_file.write_text(json.dumps({"enabled": True, "filter": {"z": True}}))
    fake_trigger = MagicMock()
    fake_trigger.name = "builtin_toplog_watcher"
    fake_trigger.id = "fake-id"

    # broadcast() no-ops with no connected clients; the apply is what we assert.
    await _toplog_filter_apply(fake_trigger, [ChangeEvent(path=_toplog_file, change_type="modified")])
    assert toplog.is_on("z") is True


# ── dev/prod seeding default ─────────────────────────────────────────────────


def test_toplog_enabled_defaults_dev_on_prod_off():
    from flow_sdk.instance_settings.base_settings import BaseInstanceSettings
    from flow_sdk.instance_settings.dev_settings import DevInstanceSettings

    assert DevInstanceSettings.from_env().toplog_enabled is True
    assert BaseInstanceSettings.from_env().toplog_enabled is False
