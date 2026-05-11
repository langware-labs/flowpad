"""Fast unit tests for the backend AgenticProcess spawn sites.

Covers:
  - scan_actions.py  ``createProcess``  (_scan_create_process, fresh)
  - scan_actions.py  ``upsertSessionProcess`` (_scan_upsert_session_process, resume)

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


_PATCH_REQ_SCAN = "flow_sdk.builtin.faas.scan_actions.get_current_request_info"


# ─── createProcess fresh path ────────────────────────────────────────────────


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
            self.shell_id = None

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS", resp.message if hasattr(resp, "message") else resp
    assert resp.data["id"] == "fresh-1"
    # Validate post-refactor field set
    expected = {
        "worker_type", "instruction_content", "cli_config", "context_data",
        "workdir", "visible", "additional_dirs", "project_id", "target_vfs_path",
    }
    assert expected.issubset(captured.keys()), captured.keys()
    assert captured["workdir"] == "/tmp/proj"
    assert captured["visible"] is True
    assert "source_vfs_path" not in captured
    # Visible processes must be eagerly started so the terminal tab strip
    # gets a fully-attached row in one round-trip.
    assert captured.get("__started_visible") is True


@pytest.mark.asyncio
async def test_scan_create_process_headless_does_not_eagerly_start():
    """Headless (visible=False) processes manage their lifecycle per-turn via
    ``run_print_turn``. Eagerly calling ``start()`` here pre-allocates a
    session_id without ever writing a JSONL, which then makes the next
    ``/prompt`` land on a stale session and emit no assistant turn."""
    node = _make_compute_node()
    info = _make_request_info({
        "context": {"workdir": "/tmp/proj"},
        "visible": False,
    })

    captured: dict = {}

    class FakeProc:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "headless-1"
            self.type = "agentic_process"
            self.shell_id = None

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS"
    assert resp.data["id"] == "headless-1"
    assert captured["visible"] is False
    # Critical: start_pty() must NOT be called for headless processes.
    assert "__started_visible" not in captured


# ─── upsertSessionProcess resume path ────────────────────────────────────────


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
            self.shell_id = None
            self.visible = kwargs.get("visible", False)
            self.worker_type = kwargs.get("worker_type")

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

        def model_dump(self, mode=None):
            return {
                "id": self.id,
                "type": self.type,
                "session_id": self.session_id,
                "cli_config": self.cli_config,
                "workdir": self.workdir,
                "shell_id": self.shell_id,
                "visible": self.visible,
                "worker_type": self.worker_type,
            }

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_upsert_session_process()

    assert resp.status == "SUCCESS", resp
    # Production returns ``process.model_dump(mode="json")`` directly — there's
    # no ``created`` flag injection in the response (AgenticProcess has no such
    # field). The fresh-vs-resume distinction is verified via captured kwargs.
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
    existing.shell_id = "shell-1"
    existing.visible = True
    existing.worker_type = "claude"
    existing.pty_pid = None
    # ``_scan_upsert_session_process`` returns ``process.model_dump(mode="json")``
    # to the caller; configure the mock to produce a real dict so the response
    # has ``data["id"] == "existing-id"`` instead of a recursive MagicMock.
    existing.model_dump.return_value = {
        "id": "existing-id",
        "type": "agentic_process",
        "session_id": "sess-existing",
        "shell_id": "shell-1",
        "visible": True,
        "worker_type": "claude",
        "pty_pid": None,
        "created": False,
    }

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
    assert resp.data["id"] == "existing-id"
    assert resp.data["type"] == "agentic_process"
    assert resp.data["session_id"] == "sess-existing"
    # Production returns ``process.model_dump(mode="json")`` directly; no
    # ``created`` flag is injected. The "no new construction" property is
    # verified via FakeProc.constructed below.
    assert FakeProc.constructed is False, "Should not construct a new entity on resume hit"
