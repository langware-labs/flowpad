"""CLI tests for `flow diagnose` and `flow diagnose-report`.

These exercise the CLI plumbing only — the agent run (`_run_diagnose`) and the
SDK reporter (`create_diagnostic_report`) are mocked, so no worker is spawned and
no DB is touched. The reporter's real behavior is covered by
tests/unit/test_diagnostic_report.py.
"""
import asyncio
import json
import logging
from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands.diagnose_cmd import _find_skill_dir, _Renderer, _report_marker_path
from flow_sdk.cli.flow_cli import app

runner = CliRunner()

_RUN = "flow_sdk.cli.commands.diagnose_cmd._run_diagnose"
_REPORT = "flow_sdk.diagnostics.report.create_diagnostic_report"


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
# flow diagnose-report — thin wrapper over the SDK reporter
# --------------------------------------------------------------------------- #

def test_diagnose_report_prints_json_ids():
    fake = {"feed_entry_id": "fe1", "conversation_id": "c1", "flow_message_id": "m1"}
    with patch(_REPORT, new=AsyncMock(return_value=fake)) as mock_rep:
        result = runner.invoke(
            app,
            ["diagnose-report", "--summary", "freed port", "--status", "fixed",
             "--platform", "macOS"],
        )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output.strip()) == fake
    assert mock_rep.call_args.kwargs["summary"] == "freed port"
    assert mock_rep.call_args.kwargs["status"] == "fixed"
    assert mock_rep.call_args.kwargs["platform"] == "macOS"


def test_diagnose_report_requires_summary():
    result = runner.invoke(app, ["diagnose-report", "--status", "fixed"])
    assert result.exit_code != 0  # --summary is required


def test_diagnose_report_status_defaults_informational():
    with patch(_REPORT, new=AsyncMock(return_value={"skipped": "x"})) as mock_rep:
        result = runner.invoke(app, ["diagnose-report", "--summary", "s"])
    assert result.exit_code == 0
    assert mock_rep.call_args.kwargs["status"] == "informational"


def test_diagnose_report_writes_completion_marker(tmp_path, monkeypatch):
    # The marker is how the parent `flow diagnose` reliably learns the agent's
    # child `flow diagnose-report` ran (cross-process, no DB diff).
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    fake = {"feed_entry_id": "fe9", "conversation_id": "c", "flow_message_id": "m"}
    with patch(_REPORT, new=AsyncMock(return_value=fake)):
        result = runner.invoke(app, ["diagnose-report", "--summary", "s", "--status", "fixed"])
    assert result.exit_code == 0
    marker = _report_marker_path()
    assert marker == tmp_path / "diagnostics" / "last_report.json"
    assert marker.exists()
    assert json.loads(marker.read_text())["feed_entry_id"] == "fe9"


# --------------------------------------------------------------------------- #
# _Renderer — compact transcript rendering
# --------------------------------------------------------------------------- #

def _entry(role, blocks):
    return {"message": {"role": role, "content": blocks}}


def test_renderer_shows_narration_and_pulse_not_tool_noise(capsys):
    r = _Renderer()
    r.feed(_entry("assistant", [{"type": "text", "text": "Checking port"}]))
    r.feed(_entry("assistant", [{"type": "tool_use", "name": "Bash"}]))
    r.feed(_entry("assistant", [{"type": "tool_use", "name": "Bash"}]))
    r.feed(_entry("user", [{"type": "tool_result", "content": "x"}]))  # ignored
    r.finish()
    out = capsys.readouterr().out
    assert "▸ Checking port" in out          # narration kept
    assert "·" in out                         # progress pulse rendered
    assert "Bash" not in out                  # tool name suppressed
    assert "tool result" not in out           # tool-result noise suppressed


def test_renderer_ignores_non_message_entries(capsys):
    r = _Renderer()
    r.feed({"type": "system", "subtype": "init"})  # no "message" key
    r.finish()
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------- #
# _find_skill_dir
# --------------------------------------------------------------------------- #

def test_find_skill_dir_locates_installed_skill():
    d = _find_skill_dir()
    assert d is not None
    assert (d / "SKILL.md").exists()
