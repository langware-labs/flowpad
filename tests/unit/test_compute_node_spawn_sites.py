"""Fast unit tests for the three backend AgenticProcess spawn sites.

Covers:
  - compute_node.py:546  ``elevate-shell``  (_elevate_shell)
  - scan_actions.py:318  ``createProcess``  (_scan_create_process, fresh)
  - scan_actions.py:456  ``upsertSessionProcess`` (_scan_upsert_session_process, resume)

We mock get_current_request_info, AgenticProcess.save, and AgenticProcess.start
so the tests run in milliseconds without a DB or real PTY. The goal is to
validate post-`asset_ref` refactor constructor args (no `source_vfs_path`,
correct field names) and that the action returns a success response.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.responses.response import ApiSuccessResponse


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_compute_node() -> ComputeNode:
    # Real instance so the action's exception/log paths can read self.id without
    # triggering pydantic AttributeError (which would mask the real failure).
    return ComputeNode()


def _make_request_info(body: dict):
    info = MagicMock()
    info.someone_typeid = None
    info.request = MagicMock()
    info.get_post_data = AsyncMock(return_value=body)
    return info


_PATCH_REQ = "flow_sdk.builtin.faas.compute_node.get_current_request_info"
_PATCH_REQ_SCAN = "flow_sdk.builtin.faas.scan_actions.get_current_request_info"


# ─── elevate-shell (compute_node.py:546) ─────────────────────────────────────


@pytest.mark.asyncio
async def test_elevate_shell_constructs_agentic_process_with_post_refactor_fields():
    """_elevate_shell must build AgenticProcess(shell_id=, session_id=, cli_config=)
    with the post-asset_ref-refactor schema (no source_vfs_path) and persist it."""
    node = _make_compute_node()
    info = _make_request_info({
        "shell_id": "shell-abc",
        "model": "claude-sonnet-4-5",
        "permission_mode": "bypassPermissions",
    })

    captured: dict = {}

    class FakeProc:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "proc-1"
            self.type = "agentic_process"

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start(self):
            return ApiSuccessResponse(data={"id": self.id, "type": self.type})

    with patch(_PATCH_REQ, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._elevate_shell()

    assert isinstance(resp, ApiSuccessResponse)
    assert resp.data == {"id": "proc-1", "type": "agentic_process"}
    # post-refactor schema: only shell_id, session_id, cli_config — no source_vfs_path
    assert captured["shell_id"] == "shell-abc"
    assert isinstance(captured["session_id"], str) and len(captured["session_id"]) > 0
    assert isinstance(captured["cli_config"], dict)
    assert "source_vfs_path" not in captured


@pytest.mark.asyncio
async def test_elevate_shell_missing_shell_id_returns_fail():
    node = _make_compute_node()
    info = _make_request_info({})
    with patch(_PATCH_REQ, return_value=info):
        resp = await node._elevate_shell()
    assert resp.status == "FAIL"
    assert "shell_id" in resp.message


@pytest.mark.asyncio
async def test_elevate_shell_resume_uses_provided_session_id():
    """When resume_session_id is provided, AgenticProcess.session_id == that id and
    cli_config carries resume=True."""
    node = _make_compute_node()
    info = _make_request_info({
        "shell_id": "shell-xyz",
        "resume_session_id": "session-resume-1",
    })
    captured: dict = {}

    class FakeProc:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "p"
            self.type = "agentic_process"

        async def save(self, owner=None): pass
        async def start(self): return ApiSuccessResponse(data={"id": "p"})

    with patch(_PATCH_REQ, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        await node._elevate_shell()

    assert captured["session_id"] == "session-resume-1"
    assert captured["cli_config"].get("resume") is True


# ─── createProcess fresh path (scan_actions.py:318) ──────────────────────────


@pytest.mark.asyncio
async def test_scan_create_process_fresh_path_constructs_with_post_refactor_fields():
    """_scan_create_process must construct AgenticProcess with the field set
    declared at scan_actions.py:318-328 — and never source_vfs_path."""
    node = _make_compute_node()
    info = _make_request_info({
        "context": {
            "workdir": "/tmp/proj",
            "permission_mode": "bypassPermissions",
        },
        "visible": True,
    })

    captured: dict = {}

    class FakeProc:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "fresh-1"
            self.type = "agentic_process"

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS", resp.message if hasattr(resp, "message") else resp
    assert resp.data["id"] == "fresh-1"
    # Validate post-refactor field set
    expected = {
        "worker_type", "instruction_content", "cli_config", "context_data",
        "workdir", "visible", "additional_dirs", "project_id", "target_typeid_str",
    }
    assert expected.issubset(captured.keys()), captured.keys()
    assert captured["workdir"] == "/tmp/proj"
    assert captured["visible"] is True
    assert "source_vfs_path" not in captured


# ─── upsertSessionProcess resume path (scan_actions.py:456) ──────────────────


@pytest.mark.asyncio
async def test_scan_upsert_session_process_creates_fresh_when_no_existing():
    """When no existing AgenticProcess matches session_id, a new one is built
    with session_id, use_worker_history=True, context_data, project_id,
    project_encoded_name — no source_vfs_path."""
    node = _make_compute_node()
    info = _make_request_info({
        "sessionId": "sess-new-1",
        "workdir": "/tmp/wd",
    })

    captured: dict = {}

    class FakeProc:
        # get_all returns [] (no existing), so fall through to construct branch
        @classmethod
        async def get_all(cls, entities_filter=None):
            return []

        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "new-2"
            self.type = "agentic_process"
            self.session_id = kwargs.get("session_id")
            self.cli_config = kwargs.get("cli_config", {}) or {}
            self.workdir = kwargs.get("workdir")

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_upsert_session_process()

    assert resp.status == "SUCCESS", resp
    assert resp.data["created"] is True
    assert resp.data["session_id"] == "sess-new-1"
    assert captured["session_id"] == "sess-new-1"
    assert captured["use_worker_history"] is True
    assert "context_data" in captured
    assert "source_vfs_path" not in captured


@pytest.mark.asyncio
async def test_scan_upsert_session_process_returns_existing_on_resume():
    """When an AgenticProcess with the same session_id already exists, return it
    without constructing a new one."""
    node = _make_compute_node()
    info = _make_request_info({"sessionId": "sess-existing"})

    existing = MagicMock()
    existing.id = "existing-id"
    existing.type = "agentic_process"
    existing.session_id = "sess-existing"

    class FakeProc:
        constructed = False

        @classmethod
        async def get_all(cls, entities_filter=None):
            return [existing]

        def __init__(self, **kwargs):
            FakeProc.constructed = True

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_upsert_session_process()

    assert resp.status == "SUCCESS"
    assert resp.data == {
        "id": "existing-id",
        "type": "agentic_process",
        "session_id": "sess-existing",
        "created": False,
    }
    assert FakeProc.constructed is False, "Should not construct a new entity on resume hit"
