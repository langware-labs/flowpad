"""The Flowpad Assistant keeps one chat per dock context: a chat is found by the
``context_key`` it was created with, and it is told what page it belongs to.

Drives the REAL ``_scan_create_process`` with the request the assistant sends;
only the persistence/request boundaries are patched.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode


@pytest.mark.asyncio
async def test_create_stamps_context_key_and_the_page_instructions(monkeypatch) -> None:
    info = MagicMock()
    info.someone_typeid = None
    info.get_post_data = AsyncMock(
        return_value={
            "context": {
                "output_format": "stream-json",
                "process_type": "chat",
                "target_typeid_str": "project-asst",
                "context_key": "assets|project:p|agent/a",
                "instructions": "This Flowpad Assistant chat belongs to the Flowpad page the user has open: p › a.",
            },
            "pty_mode": False,
        }
    )
    saved: dict = {}

    async def _capture_save(self, owner=None, notify: bool = True):
        saved["proc"] = self

    monkeypatch.setattr("flow_sdk.builtin.faas.scan_actions.get_current_request_info", lambda: info)
    monkeypatch.setattr(AgenticProcess, "save", _capture_save)
    monkeypatch.setattr(AgenticProcess, "is_installed", AsyncMock(return_value=True))
    # Funding is not under test: a launch on a box where something funds the harness.
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source

    monkeypatch.setattr(llm_source, "check_unchecked_login", AsyncMock(return_value=None))
    monkeypatch.setattr(
        llm_source, "llm_picker_view", AsyncMock(return_value=SimpleNamespace(chosen=object(), blocked=""))
    )

    resp = await ComputeNode()._scan_create_process()
    assert resp.status == "SUCCESS", getattr(resp, "message", resp)

    proc = saved["proc"]
    # A top-level field — the assistant's query matches on it — not left in context_data.
    assert proc.context_key == "assets|project:p|agent/a"
    assert "context_key" not in (proc.context_data or {})
    assert resp.data["context_key"] == "assets|project:p|agent/a"
    # The page rides the worker's system-prompt append for the chat's whole life.
    assert "p › a" in (await proc.resolve_system_instructions() or "")
