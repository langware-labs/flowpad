"""`flow process start "<prompt>"`: one headless turn in-process, streamed, its verdict the exit code.

On the mock worker, so no CLI is spawned and no model is called. The live, loginless proof — a
container with only the wheel, funded by a public hub endpoint — is
``tests/long_tests/test_loginless_in_docker.py``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.cli.commands import process_cmd
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus


@pytest.fixture(autouse=True)
def _no_bootstrap():
    # ``@local`` + a compute node, which the shared test DB already has; this file tests the turn.
    with patch("flow_sdk.migrations.runner._bootstrap_local", new_callable=AsyncMock):
        yield


async def test_streams_the_answer_and_exits_ok(mock_driver, tmp_path, capsys):
    driver = mock_driver(response_for=lambda prompt: "pong")
    rc = await process_cmd._run_start("say pong", worker_type="claude_code", workdir=str(tmp_path))
    out, err = capsys.readouterr()
    assert rc == 0
    assert out.strip().splitlines()[-1] == "pong"
    assert "running agentic process agentic_process-" in err
    assert "pong" not in err  # the answer is stdout's alone
    assert driver.received_prompts and "say pong" in driver.received_prompts[-1]


async def test_a_failed_turn_is_a_nonzero_exit_with_its_reason(mock_driver, tmp_path, capsys):
    mock_driver(response_for=lambda prompt: "half an answer")
    with patch.object(AgenticProcess, "fetch_worker_status", return_value=WorkerStatus.ERROR):
        rc = await process_cmd._run_start("go", worker_type="claude_code", workdir=str(tmp_path))
    _, err = capsys.readouterr()
    assert rc == 1
    assert err.strip().splitlines()[-1]  # says why, not just a code


async def test_a_worker_that_never_starts_is_an_answer_not_a_raise(mock_driver, tmp_path, capsys):
    mock_driver()
    with patch.object(AgenticProcess, "stream_transcript", side_effect=RuntimeError("no usable LLM source")):
        rc = await process_cmd._run_start("go", worker_type="claude_code", workdir=str(tmp_path))
    _, err = capsys.readouterr()
    assert rc == 1
    assert "no usable LLM source" in err


async def test_with_no_worker_named_the_builtin_rule_picks_it(mock_driver, tmp_path):
    """No ``--worker`` takes ``resolve_builtin_worker_type`` — the selected harness when
    installed, else deepagents (that rule's own cases: test_builtin_worker_resolution.py)."""
    mock_driver(response_for=lambda prompt: "ok")
    rule = AsyncMock(return_value=WorkerType.DEEPAGENTS.value)
    with patch("flow_sdk.core.capabilities.registry.resolve_builtin_worker_type", rule):
        assert await process_cmd._run_start("go", workdir=str(tmp_path)) == 0
    rule.assert_awaited_once()


def test_refuses_beside_a_running_backend():
    with patch.object(process_cmd, "_discover_port", return_value=9999):
        result = CliRunner().invoke(process_cmd.process_app, ["start", "hi"])
    assert result.exit_code == process_cmd.EXIT_INSTANCE_RUNNING
    assert "INSTANCE_RUNNING" in result.output


def test_an_unknown_worker_is_an_invalid_argument():
    with patch.object(process_cmd, "_discover_port", return_value=None):
        result = CliRunner().invoke(process_cmd.process_app, ["start", "hi", "--worker", "nope"])
    assert result.exit_code == process_cmd.EXIT_INVALID_ARG
    assert "UNKNOWN_WORKER" in result.output
