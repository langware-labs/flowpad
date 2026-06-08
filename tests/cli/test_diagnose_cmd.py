"""CLI tests for `flow diagnose`.

These exercise the CLI plumbing only — the agent run (`_run_diagnose`) is mocked,
so no worker is spawned and no DB is touched. The SDK reporter's real behavior is
covered by tests/unit/test_diagnostic_report.py.
"""
import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands.diagnose_cmd import _print_agent_text
from flow_sdk.cli.flow_cli import app

runner = CliRunner()

_RUN = "flow_sdk.cli.commands.diagnose_cmd._run_diagnose"


@pytest.fixture(autouse=True)
def _isolate_cli_side_effects():
    """Undo global side effects of invoking the CLI so they don't leak into
    other tests:
    - `_quiet_logs()` calls `logging.disable(WARNING)` — re-enable logging.
    - The command's `asyncio.run()` resets the thread's current event loop to
      None on completion; save the session loop and restore it so later async
      tests/fixtures (asyncio_mode=auto) still find a current loop.
    """
    try:
        saved_loop = asyncio.get_event_loop_policy().get_event_loop()
    except RuntimeError:
        saved_loop = None
    yield
    logging.disable(logging.NOTSET)
    if saved_loop is not None:
        asyncio.set_event_loop(saved_loop)


# --------------------------------------------------------------------------- #
# flow diagnose — message comes from stdin, never argv
# --------------------------------------------------------------------------- #

def test_diagnose_reads_message_from_stdin():
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose"], input="backend keeps crashing\n")
    assert result.exit_code == 0, result.output
    assert mock_run.call_args.args[0] == "backend keeps crashing"
    assert "Diagnosing your issue" in result.output


def test_diagnose_empty_input_runs_full_sweep():
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose"], input="\n")
    assert result.exit_code == 0
    assert mock_run.call_args.args[0] == ""  # empty → full sweep
    assert "Running a full diagnostic sweep" in result.output


def test_diagnose_preserves_quotes_and_apostrophes():
    # The entire reason for reading from stdin: shell-special chars pass through
    # intact (no quoting / no shell mangling).
    msg = "can't start \"the app\" — is it broken?"
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose"], input=msg + "\n")
    assert result.exit_code == 0
    assert mock_run.call_args.args[0] == msg


def test_diagnose_only_first_line_is_the_message():
    # readline() → one line; Enter submits, the rest is ignored.
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose"], input="first line\nsecond line\n")
    assert result.exit_code == 0
    assert mock_run.call_args.args[0] == "first line"


def test_diagnose_propagates_exit_code():
    with patch(_RUN, new=AsyncMock(return_value=1)):
        result = runner.invoke(app, ["diagnose"], input="something\n")
    assert result.exit_code == 1


def test_diagnose_passes_timeout_through():
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose", "--timeout", "42"], input="x\n")
    assert result.exit_code == 0
    assert mock_run.call_args.args[1] == 42.0


# --------------------------------------------------------------------------- #
# _print_agent_text — streams only assistant narration
# --------------------------------------------------------------------------- #

def _entry(role, blocks):
    return {"message": {"role": role, "content": blocks}}


def test_print_agent_text_shows_assistant_narration(capsys):
    _print_agent_text(_entry("assistant", [{"type": "text", "text": "Checking port"}]))
    out = capsys.readouterr().out
    assert "▸ Checking port" in out


def test_print_agent_text_ignores_tool_use_and_non_assistant(capsys):
    _print_agent_text(_entry("assistant", [{"type": "tool_use", "name": "Bash"}]))
    _print_agent_text(_entry("user", [{"type": "text", "text": "ignored"}]))
    _print_agent_text({"type": "system", "subtype": "init"})  # no "message" key
    assert capsys.readouterr().out == ""
