"""Step 16: `set_service_triggers()` — upserts canonical system FSOp triggers."""
from __future__ import annotations

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.hook_models import ActionType
from flow_sdk.builtin.trigger import Trigger, TriggerType
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.server.builtin_triggers import set_service_triggers


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


async def test_toplog_callback_is_registered_at_import():
    """The @register decorator runs on module load."""
    assert trigger_callbacks.get("builtin_toplog_filter_apply") is not None


async def test_creates_toplog_watcher_on_fresh_db(initialize_test_db):
    settings = get_instance_settings()

    await set_service_triggers()

    trigger = await Trigger.get_by_uname("builtin_toplog_watcher")
    assert trigger is not None
    assert trigger.trigger_type == TriggerType.FSOP
    assert trigger.watch_path == str(settings.toplog_config_path)
    assert [a.action_type for a in trigger.actions] == [ActionType.CALLBACK]
    assert trigger.actions[0].callback_name == "builtin_toplog_filter_apply"


async def test_idempotent_across_reruns(initialize_test_db):
    """Two calls produce a single trigger entity (uname-keyed upsert)."""
    await set_service_triggers()
    first = await Trigger.get_by_uname("builtin_toplog_watcher")
    await set_service_triggers()
    second = await Trigger.get_by_uname("builtin_toplog_watcher")
    assert second.id == first.id


async def test_transcript_route_callback_registered_at_import():
    """T5: The streamer route callback registers at module import (via the
    lazy import in _service_trigger_specs())."""
    # Force the lazy import path
    from flow_sdk.server.builtin_triggers import _service_trigger_specs
    _service_trigger_specs()
    assert trigger_callbacks.get("builtin_transcript_streamer_route") is not None


async def test_creates_transcript_watchers(initialize_test_db):
    """T5: Claude + Codex transcript watcher triggers are installed by set_service_triggers."""
    settings = get_instance_settings()
    await set_service_triggers()

    for uname, expected_path in (
        ("builtin_claude_transcript_watcher", str(settings.claude_projects_dir)),
        ("builtin_codex_transcript_watcher", str(settings.codex_sessions_dir)),
    ):
        t = await Trigger.get_by_uname(uname)
        assert t is not None, f"{uname} should be installed"
        assert t.trigger_type == TriggerType.FSOP
        assert t.watch_path == expected_path
        assert t.recursive is True
        assert t.watch_glob == "*.jsonl"
        assert len(t.actions) == 1
        assert t.actions[0].action_type == ActionType.CALLBACK
        assert t.actions[0].callback_name == "builtin_transcript_streamer_route"


async def test_seeds_toplog_json_when_missing(initialize_test_db, tmp_path, monkeypatch):
    """The function ensures toplog.json exists so awatch attaches cleanly.

    Settings is a frozen dataclass, so we proxy `get_instance_settings()` to
    return an object that redirects just `toplog_config_path` to tmp.
    """
    fake_toplog = tmp_path / "toplog.json"
    from flow_sdk.server import builtin_triggers as bt
    real_settings = bt.get_instance_settings()

    class _Proxy:
        toplog_config_path = fake_toplog
        def __getattr__(self, n): return getattr(real_settings, n)

    monkeypatch.setattr(bt, "get_instance_settings", lambda: _Proxy())
    await set_service_triggers()
    assert fake_toplog.exists()
