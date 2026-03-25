"""Unit tests for ComputeNode.get_cwd_action().

Patches run_command at the class level (Pydantic blocks instance attribute writes).
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.flowpad_types.compute_types import CLICommand


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_cmd(stdout: str | None) -> CLICommand:
    cmd = MagicMock(spec=CLICommand)
    cmd.all_stdout = stdout
    return cmd


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_cwd_returns_path():
    with patch.object(ComputeNode, "run_command", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = make_cmd("/home/user/project")
        response = await ComputeNode().get_cwd_action()
    assert response.status == "SUCCESS"
    assert response.data["cwd"] == "/home/user/project"


@pytest.mark.asyncio
async def test_get_cwd_strips_trailing_newline():
    with patch.object(ComputeNode, "run_command", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = make_cmd("/home/user/project\n")
        response = await ComputeNode().get_cwd_action()
    assert response.data["cwd"] == "/home/user/project"


@pytest.mark.asyncio
async def test_get_cwd_empty_stdout_returns_empty_string():
    with patch.object(ComputeNode, "run_command", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = make_cmd("")
        response = await ComputeNode().get_cwd_action()
    assert response.status == "SUCCESS"
    assert response.data["cwd"] == ""


@pytest.mark.asyncio
async def test_get_cwd_none_stdout_returns_empty_string():
    with patch.object(ComputeNode, "run_command", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = make_cmd(None)
        response = await ComputeNode().get_cwd_action()
    assert response.status == "SUCCESS"
    assert response.data["cwd"] == ""


@pytest.mark.asyncio
async def test_get_cwd_calls_pwd():
    with patch.object(ComputeNode, "run_command", new_callable=AsyncMock) as mock_run:
        mock_run.return_value = make_cmd("/tmp")
        await ComputeNode().get_cwd_action()
    mock_run.assert_called_once_with("pwd", background=False)
