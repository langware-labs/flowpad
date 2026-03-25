"""
API tests for AgenticProcess plan actions: execute-plan and update-plan.

Tests the execute-plan and update-plan actions on AgenticProcess:
- POST /api/v1/graph/agentic_process/{id}/execute-plan
- POST /api/v1/graph/agentic_process/{id}/update-plan
"""

import tempfile
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_processor import AgenticProcess
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_plan_file(content: str) -> Path:
    """Create a temporary plan file and return its path."""
    temp_dir = Path(tempfile.gettempdir())
    plan_dir = temp_dir / ".claude" / "plans"
    plan_dir.mkdir(parents=True, exist_ok=True)
    plan_path = plan_dir / f"test-plan-{uuid.uuid4()}.md"
    plan_path.write_text(content, encoding="utf-8")
    return plan_path


# ---------------------------------------------------------------------------
# Tests: execute-plan action
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_execute_plan_success(bootstrapped_client, user):
    """POST execute-plan with valid file path returns success."""
    client = bootstrapped_client

    # Create a process
    process = AgenticProcess(
        name="test-process-execute",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    # Create a temporary plan file
    plan_content = "# Test Plan\n\n1. First step\n2. Second step"
    plan_path = _make_plan_file(plan_content)

    try:
        # Call execute-plan action
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
            json={"file_path": str(plan_path), "clear_context": False},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("injected") is True

    finally:
        plan_path.unlink()
        await process.delete()


@pytest.mark.asyncio
async def test_execute_plan_with_clear_context(bootstrapped_client, user):
    """execute-plan with clear_context=True sends /clear first."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-clear",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    plan_path = _make_plan_file("# Clear Plan")

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
            json={"file_path": str(plan_path), "clear_context": True},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("injected") is True

    finally:
        plan_path.unlink()
        await process.delete()


@pytest.mark.asyncio
async def test_execute_plan_nonexistent_file_path(bootstrapped_client, user):
    """execute-plan with non-existent file path returns success (desktop stub)."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-nonexistent",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
            json={"file_path": "/nonexistent/plan.md", "clear_context": False},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        # Desktop stub doesn't validate files, just accepts the request
        assert res.status == ApiResponseStatus.SUCCESS.value

    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_execute_plan_with_valid_content(bootstrapped_client, user):
    """execute-plan with valid file path and content returns success."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-valid",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    plan_path = _make_plan_file("# Comprehensive Plan\n\n1. Step one\n2. Step two")

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
            json={"file_path": str(plan_path), "clear_context": False},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("injected") is True

    finally:
        plan_path.unlink()
        await process.delete()


# ---------------------------------------------------------------------------
# Tests: update-plan action
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_plan_success(bootstrapped_client, user):
    """POST update-plan with valid file containing <plan-note> returns success."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-update",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    plan_content = (
        "# Plan with Notes\n\n"
        "Original plan text.\n\n"
        "<plan-note>This needs updating because reasons</plan-note>\n\n"
        "More plan text."
    )
    plan_path = _make_plan_file(plan_content)

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/update-plan",
            json={"file_path": str(plan_path)},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("ok") is True

    finally:
        plan_path.unlink()
        await process.delete()


@pytest.mark.asyncio
async def test_update_plan_without_notes(bootstrapped_client, user):
    """update-plan still succeeds even without <plan-note> sections."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-update-no-notes",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    plan_path = _make_plan_file("# Plan\n\nNo notes here.")

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/update-plan",
            json={"file_path": str(plan_path)},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("ok") is True

    finally:
        plan_path.unlink()
        await process.delete()


@pytest.mark.asyncio
async def test_update_plan_missing_file(bootstrapped_client, user):
    """update-plan with non-existent file returns success (desktop stub)."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-update-missing",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/update-plan",
            json={"file_path": "/nonexistent/plan.md"},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        # Desktop stub doesn't validate files
        assert res.status == ApiResponseStatus.SUCCESS.value

    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_update_plan_with_multiple_notes(bootstrapped_client, user):
    """update-plan with file containing multiple <plan-note> sections returns success."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-process-update-multi",
        worker_session_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    plan_content = (
        "# Plan with Multiple Notes\n\n"
        "<plan-note>Fix this part</plan-note>\n\n"
        "Some content\n\n"
        "<plan-note>And also update this</plan-note>\n\n"
        "More content"
    )
    plan_path = _make_plan_file(plan_content)

    try:
        resp = await client.post(
            f"/api/v1/graph/agentic_process/{process.id}/update-plan",
            json={"file_path": str(plan_path)},
        )
        assert resp.status_code == 200, resp.text
        res = ApiResponse(**resp.json())
        assert res.status == ApiResponseStatus.SUCCESS.value
        assert res.data.get("ok") is True

    finally:
        plan_path.unlink()
        await process.delete()
