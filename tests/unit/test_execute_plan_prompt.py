"""Unit tests for execute-plan and update-plan prompt construction.

Verifies that file_path is required and included in the injected prompt,
especially after clear_context wipes Claude's memory.
"""

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process import agentic_process as _ap_module


def _make_process(**kwargs) -> AgenticProcess:
    defaults = dict(
        shell_id="shell-123",
        session_id="ws-123",
        status="running",
        context_data={},
    )
    defaults.update(kwargs)
    return AgenticProcess(**defaults)


# ── execute-plan ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_execute_plan_includes_file_path_in_prompt():
    """When file_path is given, the injected prompt must reference it."""
    proc = _make_process()
    injected: list[str] = []

    with patch.object(AgenticProcess, "inject", new_callable=AsyncMock, side_effect=lambda msg: injected.append(msg)):
        await proc.execute_plan(file_path="/plans/my-plan.md", clear_context=False)

    assert len(injected) == 1
    assert "/plans/my-plan.md" in injected[0]


@pytest.mark.asyncio
async def test_execute_plan_prompt_mentions_plan_note_and_execution():
    """execute-plan prompt must mention plan-note updates AND continuing to execution."""
    proc = _make_process()
    injected: list[str] = []

    with patch.object(AgenticProcess, "inject", new_callable=AsyncMock, side_effect=lambda msg: injected.append(msg)):
        await proc.execute_plan(file_path="/plans/my-plan.md", clear_context=False)

    prompt = injected[0]
    assert "plan-note" in prompt
    assert "execute plan" in prompt.lower()


@pytest.mark.asyncio
async def test_execute_plan_clear_context_includes_file_path():
    """After /clear, Claude needs the file path to know which plan to execute."""
    proc = _make_process()
    injected: list[str] = []

    with patch.object(AgenticProcess, "inject", new_callable=AsyncMock, side_effect=lambda msg: injected.append(msg)):
        with patch("asyncio.sleep", new_callable=AsyncMock):
            await proc.execute_plan(file_path="/plans/my-plan.md", clear_context=True)

    # First message is /clear, second is the execute prompt
    assert injected[0] == "/clear"
    assert "/plans/my-plan.md" in injected[1]
    assert "plan-note" in injected[1]


@pytest.mark.asyncio
async def test_execute_plan_rejects_empty_file_path():
    """execute-plan with empty string file_path returns FAIL."""
    proc = _make_process()

    result = await proc.execute_plan(file_path="", clear_context=False)
    assert result.status == "FAIL"
    assert "file_path" in result.message.lower()


# ── update-plan ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_plan_includes_file_path_in_prompt():
    """When file_path is given, update-plan prompt must reference it."""
    proc = _make_process()
    injected: list[str] = []

    with patch.object(AgenticProcess, "inject", new_callable=AsyncMock, side_effect=lambda msg: injected.append(msg)):
        await proc.update_plan(file_path="/plans/my-plan.md")

    assert len(injected) == 1
    assert "/plans/my-plan.md" in injected[0]
    assert "plan-note" in injected[0]


@pytest.mark.asyncio
async def test_update_plan_rejects_empty_file_path():
    """update-plan with empty string file_path returns FAIL."""
    proc = _make_process()

    result = await proc.update_plan(file_path="")
    assert result.status == "FAIL"
    assert "file_path" in result.message.lower()


@pytest.mark.asyncio
async def test_update_plan_does_not_mention_execution():
    """update-plan should NOT tell Claude to continue to execution."""
    proc = _make_process()
    injected: list[str] = []

    with patch.object(AgenticProcess, "inject", new_callable=AsyncMock, side_effect=lambda msg: injected.append(msg)):
        await proc.update_plan(file_path="/plans/my-plan.md")

    prompt = injected[0]
    assert "execution" not in prompt
    assert "without additional approval" not in prompt
