"""The background CLI update check: newest version from npm, cached, silent when offline."""

import json

import httpx
import pytest

from flow_sdk.builtin.agentic_process.launch_health import LaunchError, LaunchErrorCode
from flow_sdk.core.capabilities import latest_version as lv

CODEX = "harness.codex.cli"
AMI_400 = "HTTP 400: The 'gpt-6-astra' model requires a newer version of Codex"


@pytest.fixture
def cache(tmp_path, monkeypatch):
    path = tmp_path / "cli_latest_versions.json"
    monkeypatch.setattr(lv, "_cache_path", lambda: path)
    monkeypatch.setenv("FLOW_CLI_UPDATE_CHECK", "1")
    monkeypatch.setattr(lv, "_too_old", {})
    monkeypatch.setattr(lv, "_cache", None)
    return path


def _registry(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr(lv.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


async def test_newer_release_shows_available_and_is_cached(cache, monkeypatch):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(200, json={"version": "0.152.0"})

    _registry(monkeypatch, handler)
    assert await lv.refresh_latest_versions() is True
    assert "/@openai/codex/latest" in calls
    assert lv.update_state(CODEX, "0.147.0") == ("0.152.0", "available")
    assert lv.update_state(CODEX, "0.152.0") == ("0.152.0", "none")
    n = len(calls)
    await lv.refresh_latest_versions()  # fresh cache → no second lookup
    assert len(calls) == n


async def test_offline_registry_records_nothing(cache, monkeypatch):
    def handler(req):
        raise httpx.ConnectError("offline")

    _registry(monkeypatch, handler)
    assert await lv.refresh_latest_versions() is False
    assert lv.update_state(CODEX, "0.147.0") == ("", "none")


async def test_stale_cache_and_off_switch(cache, monkeypatch):
    cache.write_text(json.dumps({CODEX: {"version": "9.9.9", "at": 0}}))
    lv._cache = None
    assert lv.update_state(CODEX, "0.147.0") == ("", "none")  # older than a day → unknown
    monkeypatch.setenv("FLOW_CLI_UPDATE_CHECK", "0")
    assert await lv.refresh_latest_versions() is False


def test_too_old_refusal_is_classified_and_marks_required(cache, monkeypatch):
    monkeypatch.setattr("flow_sdk.core.status.publish_status_changed", lambda: None)
    assert LaunchError.classify(RuntimeError(AMI_400), "codex").code is LaunchErrorCode.CLI_OUTDATED
    assert LaunchError.classify(RuntimeError("HTTP 400: bad request"), "codex").code is not LaunchErrorCode.CLI_OUTDATED
    assert lv.note_session_error(CODEX, json.dumps({"type": "error", "message": AMI_400}))
    assert lv.update_state(CODEX, "0.147.0")[1] == "required"
    assert lv.update_state(CODEX, "0.152.0")[1] == "none"  # a newer install clears it
