"""A chat with no project (e.g. about a message attachment) runs in the instance's
OWN chat-scratch folder — never the live-session scratch, never a Project.

Drives the REAL ``_scan_create_process`` action with the request the doc Chat
toggle sends (``scratch: true``, no project, no workdir). Only the persistence /
request / harness boundaries are patched, as in
``test_improve_stream_json_headless_transport.py``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.remote_worker_session import chat_scratch_workdir, scratch_workdir
from tests.utils.harness_installed import harness_installed  # noqa: F401 — a fixture

pytestmark = pytest.mark.usefixtures("harness_installed")


async def _create(monkeypatch, context: dict) -> AgenticProcess:
    info = MagicMock()
    info.someone_typeid = None
    info.request = MagicMock()
    info.get_post_data = AsyncMock(return_value={"context": context, "visible": False, "pty_mode": False})
    saved: dict = {}

    async def _capture_save(self, owner=None, notify: bool = True):
        saved["proc"] = self

    monkeypatch.setattr("flow_sdk.builtin.faas.scan_actions.get_current_request_info", lambda: info)
    monkeypatch.setattr(AgenticProcess, "save", _capture_save)
    monkeypatch.setattr(AgenticProcess, "is_installed", AsyncMock(return_value=True))
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source

    monkeypatch.setattr(llm_source, "check_unchecked_login", AsyncMock(return_value=None))
    monkeypatch.setattr(
        llm_source, "llm_picker_view", AsyncMock(return_value=SimpleNamespace(chosen=object(), blocked=""))
    )
    resp = await ComputeNode()._scan_create_process()
    assert resp.status == "SUCCESS", getattr(resp, "message", resp)
    return saved["proc"]


@pytest.mark.asyncio
async def test_projectless_chat_runs_in_chat_scratch(monkeypatch) -> None:
    proc = await _create(
        monkeypatch,
        {"output_format": "stream-json", "process_type": "chat", "scratch": True, "target_typeid_str": "x/doc.md"},
    )
    assert proc.workdir == str(chat_scratch_workdir())
    assert proc.workdir != str(scratch_workdir())
    assert proc.project_id is None
    assert "scratch" not in (proc.context_data or {})


@pytest.mark.asyncio
async def test_scratch_never_overrides_an_explicit_workdir(monkeypatch, tmp_path) -> None:
    proc = await _create(
        monkeypatch,
        {"output_format": "stream-json", "process_type": "chat", "scratch": True, "workdir": str(tmp_path)},
    )
    assert proc.workdir == str(tmp_path)
