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

from flow_sdk.cli.commands.diagnose_cmd import _Renderer
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
# _Renderer — narration lines + inline tool-progress dots
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
# _run_diagnose — must not hang when the transcript stream never self-terminates
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_run_diagnose_exits_when_recorded_even_if_stream_never_ends():
    """Regression for the Windows hang: ``_tail_status`` can fail to report
    COMPLETE (a long final report pushes the terminal markers out of its 4 KB
    tail window), so ``stream_transcript`` never returns. The command must still
    exit once a new flowpad_diagnosis record appears — the completion signal does
    NOT depend on the worker cross-linking / self-identifying (which fails on
    Windows). The 5 s ``wait_for`` is a hang DETECTOR (it makes a regression fail
    fast) — not a budget to ride past the symptom.
    """
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from flow_sdk.cli.commands import diagnose_cmd

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "fake-id"
            self.session_id = "fakesess"

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            return None

        async def stream_transcript(self, timeout=0):
            # Emit one narration entry, then never terminate (the hang we fix).
            yield {"message": {"role": "assistant", "content": [{"type": "text", "text": "working"}]}}
            await asyncio.sleep(3600)

        @classmethod
        async def get_by_id(cls, _id):
            return None

    # Diagnosis snapshot-diff: none before the run, one new after — the
    # authoritative "recorded" signal (no cross-link / process self-id needed).
    diag_calls = {"n": 0}

    class _FakeDiag:
        @classmethod
        async def get_all(cls):
            diag_calls["n"] += 1
            return [] if diag_calls["n"] == 1 else [SimpleNamespace(id="diag-1")]

        @classmethod
        async def get_by_id(cls, _id):
            return SimpleNamespace(id="diag-1")

    with (
        patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
        patch(
            "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
            lambda _t: _FakeDiag,
        ),
        patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
    ):
        rc = await asyncio.wait_for(diagnose_cmd._run_diagnose("", 1800.0), timeout=5)
    assert rc == 0
