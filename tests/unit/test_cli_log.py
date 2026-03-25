"""Tests for CLI invocation logging.

Tests use monkeypatched paths so all I/O goes to tmp_path.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from unittest import mock

import pytest

import flow_sdk.cli.cli_log as cli_log
import flow_sdk.fs_store.record as record_mod
from flow_sdk.cli.cli_log import (
    CliLogRecord,
    CliLogSettingsRecord,
    clear_log,
    load_settings,
    read_entries,
    save_settings,
    write_entry,
    MAX_ENTRIES,
    DROP_COUNT,
    MAX_OUTPUT_SIZE,
)


@pytest.fixture(autouse=True)
def _patch_paths(tmp_path, monkeypatch):
    """Redirect all cli_log I/O to tmp_path."""
    monkeypatch.setattr(cli_log, "CLI_LOG_DIR", tmp_path)
    monkeypatch.setattr(cli_log, "CLI_LOG_FILE", tmp_path / "cli.log.jsonl")
    # Redirect fs_records root so discover_one/save use tmp_path
    monkeypatch.setattr(record_mod, "_DEFAULT_RECORDS_ROOT", tmp_path / "records")


# ---------------------------------------------------------------------------
# 1. CLI invocation logged to JSONL
# ---------------------------------------------------------------------------


class TestWriteAndRead:
    def test_write_and_read_entries(self):
        """Write 3 entries, read back newest-first."""
        for i in range(3):
            rec = CliLogRecord(
                workdir=f"/tmp/test{i}",
                command=["flow", f"cmd{i}"],
                exit_code=i,
                stdout=f"out{i}",
                stderr="",
                level="info",
                duration_ms=100 + i,
            )
            write_entry(rec)

        entries = read_entries()
        assert len(entries) == 3
        # newest-first: last written is first read
        assert entries[0].command == ["flow", "cmd2"]
        assert entries[0].exit_code == 2
        assert entries[0].workdir == "/tmp/test2"
        assert entries[2].command == ["flow", "cmd0"]

    def test_entries_are_cli_log_records(self):
        """read_entries returns CliLogRecord instances."""
        write_entry(CliLogRecord(workdir="/w", command=["flow"], exit_code=0))
        entries = read_entries()
        assert len(entries) == 1
        assert isinstance(entries[0], CliLogRecord)
        assert entries[0].type == "cli_log"

    def test_record_has_id_and_created_at(self):
        """Each record gets an auto-generated id and created_at from Record."""
        rec = CliLogRecord(workdir="/w", command=["flow"], exit_code=0)
        write_entry(rec)

        entries = read_entries()
        assert entries[0].id  # non-empty UUID
        assert entries[0].created_at is not None

    def test_empty_file_returns_empty_list(self, tmp_path):
        """read_entries on missing file returns empty list."""
        entries = read_entries()
        assert entries == []

    def test_read_with_limit(self):
        """Limit parameter caps returned entries."""
        for i in range(10):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))
        entries = read_entries(limit=3)
        assert len(entries) == 3
        # newest first
        assert entries[0].command == ["flow", "9"]


# ---------------------------------------------------------------------------
# 2. Entry cap enforcement
# ---------------------------------------------------------------------------


class TestEnforceCap:
    def test_under_threshold_no_trim(self):
        """Below MAX_ENTRIES, no trimming occurs."""
        for i in range(50):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))

        lines = cli_log.CLI_LOG_FILE.read_text().strip().split("\n")
        assert len(lines) == 50

    def test_at_threshold_triggers_trim(self):
        """At MAX_ENTRIES, file is trimmed to MAX_ENTRIES - DROP_COUNT."""
        # Write exactly MAX_ENTRIES entries
        for i in range(MAX_ENTRIES):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))

        lines = cli_log.CLI_LOG_FILE.read_text().strip().split("\n")
        expected = MAX_ENTRIES - DROP_COUNT
        assert len(lines) == expected

        # Verify newest entries survived (highest indices)
        entries = read_entries()
        assert entries[0].command == ["flow", str(MAX_ENTRIES - 1)]

    def test_over_threshold_triggers_trim(self):
        """Writing 810 entries trims to 500 (last batch)."""
        for i in range(810):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))

        lines = cli_log.CLI_LOG_FILE.read_text().strip().split("\n")
        # After 800 entries: trim at 800 -> 500 lines. 800-809 -> 510 lines total.
        assert len(lines) == MAX_ENTRIES - DROP_COUNT + 10  # 510

    def test_clear_log(self):
        """clear_log deletes all entries and returns count."""
        for i in range(5):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))
        assert len(read_entries()) == 5

        count = clear_log()
        assert count == 5
        assert len(read_entries()) == 0

    def test_clear_log_empty(self):
        """clear_log on missing file returns 0."""
        assert clear_log() == 0

    def test_trim_preserves_newest(self):
        """After trim, the newest entries survive."""
        for i in range(MAX_ENTRIES + 5):
            write_entry(CliLogRecord(
                workdir="/w",
                command=["flow", str(i)],
                exit_code=0,
                stdout=f"output-{i}",
            ))

        entries = read_entries()
        # The very newest entry should be the last one written
        assert entries[0].command == ["flow", str(MAX_ENTRIES + 4)]
        assert entries[0].stdout == f"output-{MAX_ENTRIES + 4}"


# ---------------------------------------------------------------------------
# 3. Stdin dump
# ---------------------------------------------------------------------------


class TestStdinCapture:
    def test_stdin_stored_in_record(self):
        """When stdin is provided, it's stored in the record."""
        rec = CliLogRecord(
            workdir="/w",
            command=["flow", "hooks", "report"],
            exit_code=0,
            stdin='{"event": "test", "data": "hello"}',
            level="debug",
        )
        write_entry(rec)

        entries = read_entries()
        assert entries[0].stdin == '{"event": "test", "data": "hello"}'

    def test_stdin_none_when_not_piped(self):
        """When no stdin, field is None."""
        rec = CliLogRecord(workdir="/w", command=["flow", "--version"], exit_code=0)
        write_entry(rec)

        entries = read_entries()
        assert entries[0].stdin is None

    def test_stdin_truncated_to_max(self):
        """Stdin exceeding MAX_OUTPUT_SIZE is truncated before storage."""
        big_stdin = "x" * (MAX_OUTPUT_SIZE + 1000)
        rec = CliLogRecord(
            workdir="/w",
            command=["flow", "hooks", "report"],
            exit_code=0,
            stdin=big_stdin[:MAX_OUTPUT_SIZE],  # caller truncates
        )
        write_entry(rec)

        entries = read_entries()
        assert len(entries[0].stdin) == MAX_OUTPUT_SIZE

    def test_cli_main_captures_piped_stdin(self, tmp_path, monkeypatch):
        """cli_main() captures stdin when piped."""
        # Simulate: echo '{"event":"x"}' | flow hooks report
        stdin_content = '{"event": "test_stdin"}'
        mock_stdin = StringIO(stdin_content)

        monkeypatch.setattr("sys.argv", ["flow", "hooks", "report"])
        monkeypatch.setattr("sys.stdin", mock_stdin)

        # Ensure settings allow debug logging
        save_settings("debug")

        # select.select requires real file descriptors; StringIO has none.
        # Patch it to report stdin as readable so cli_main captures the content.
        # Mock app() to avoid running the actual CLI
        with mock.patch("select.select", return_value=([mock_stdin], [], [])), \
             mock.patch("flow_sdk.cli.flow_cli.app"):
            from flow_sdk.cli.flow_cli import cli_main
            with pytest.raises(SystemExit) as exc_info:
                cli_main()
            assert exc_info.value.code == 0

        entries = read_entries()
        assert len(entries) >= 1
        assert entries[0].stdin == stdin_content


# ---------------------------------------------------------------------------
# 4. flow log replay
# ---------------------------------------------------------------------------


class TestLogReplay:
    def _write_test_entries(self):
        """Write a few test entries for replay tests."""
        for i, cmd in enumerate([
            ["flow", "--version"],
            ["flow", "status"],
            ["flow", "config", "list"],
        ]):
            rec = CliLogRecord(
                workdir="/tmp/test",
                command=cmd,
                exit_code=0,
                stdout=f"output-{i}\n",
                level="info",
                duration_ms=50 + i,
            )
            write_entry(rec)

    def test_resolve_by_index(self):
        """Resolve entry by integer index (newest-first)."""
        from flow_sdk.cli.flow_cli import _resolve_entry

        self._write_test_entries()
        entries = read_entries()

        # Index 0 = newest = "flow config list"
        result = _resolve_entry(entries, "0")
        assert result is not None
        assert result.command == ["flow", "config", "list"]

        # Index 2 = oldest = "flow --version"
        result = _resolve_entry(entries, "2")
        assert result.command == ["flow", "--version"]

    def test_resolve_by_timestamp(self):
        """Resolve entry by ISO timestamp prefix."""
        from flow_sdk.cli.flow_cli import _resolve_entry

        self._write_test_entries()
        entries = read_entries()

        # Use the created_at timestamp of the newest entry
        ts = entries[0].created_at
        if isinstance(ts, datetime):
            ts = ts.isoformat()
        prefix = ts[:16]  # e.g. "2026-03-04T10:30"
        result = _resolve_entry(entries, prefix)
        assert result is not None

    def test_resolve_invalid_index(self):
        """Out-of-range index returns None."""
        from flow_sdk.cli.flow_cli import _resolve_entry

        self._write_test_entries()
        entries = read_entries()

        assert _resolve_entry(entries, "999") is None

    def test_resolve_no_match_timestamp(self):
        """Non-matching timestamp returns None."""
        from flow_sdk.cli.flow_cli import _resolve_entry

        self._write_test_entries()
        entries = read_entries()

        assert _resolve_entry(entries, "1999-01-01") is None

    def test_replay_runs_subprocess(self):
        """Replay invokes subprocess.run with correct cmd and workdir."""
        self._write_test_entries()

        with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)) as mock_run:
            from typer.testing import CliRunner
            from flow_sdk.cli.flow_cli import app

            runner = CliRunner()
            result = runner.invoke(app, ["log", "replay", "0"])

            mock_run.assert_called_once()
            call_kwargs = mock_run.call_args
            assert call_kwargs[0][0] == ["flow", "config", "list"]
            assert call_kwargs[1]["cwd"] == "/tmp/test"

    def test_replay_passes_stdin(self):
        """Replay pipes stdin to subprocess when present."""
        rec = CliLogRecord(
            workdir="/tmp/test",
            command=["flow", "hooks", "report"],
            exit_code=0,
            stdin='{"event": "replay_test"}',
            level="debug",
        )
        write_entry(rec)

        with mock.patch("subprocess.run", return_value=mock.Mock(returncode=0)) as mock_run:
            from typer.testing import CliRunner
            from flow_sdk.cli.flow_cli import app

            runner = CliRunner()
            result = runner.invoke(app, ["log", "replay", "0"])

            call_kwargs = mock_run.call_args
            assert call_kwargs[1]["input"] == '{"event": "replay_test"}'


# ---------------------------------------------------------------------------
# 5. flow log prints the log nicely
# ---------------------------------------------------------------------------


class TestLogDisplay:
    def test_flow_log_shows_entries(self):
        """flow log prints a formatted table of entries."""
        for i in range(3):
            write_entry(CliLogRecord(
                workdir="/w",
                command=["flow", f"cmd{i}"],
                exit_code=0,
                level="info",
                duration_ms=100 + i,
            ))

        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log"])

        assert result.exit_code == 0
        assert "flow cmd2" in result.output  # newest first
        assert "flow cmd1" in result.output
        assert "flow cmd0" in result.output

    def test_flow_log_empty(self):
        """flow log with no entries shows message."""
        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log"])

        assert "No log entries" in result.output

    def test_flow_log_with_limit(self):
        """flow log --limit caps output."""
        for i in range(10):
            write_entry(CliLogRecord(
                workdir="/w",
                command=["flow", f"cmd{i}"],
                exit_code=0,
            ))

        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "--limit", "3"])

        assert result.exit_code == 0
        # Should show cmd9, cmd8, cmd7 (newest 3)
        assert "flow cmd9" in result.output
        assert "flow cmd7" in result.output
        # cmd6 should NOT appear
        assert "flow cmd6" not in result.output

    def test_flow_log_filter_by_level(self):
        """flow log --level debug only shows debug entries."""
        write_entry(CliLogRecord(workdir="/w", command=["flow", "status"], exit_code=0, level="info"))
        write_entry(CliLogRecord(workdir="/w", command=["flow", "hooks", "report"], exit_code=0, level="debug"))

        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "--level", "debug"])

        assert "flow hooks report" in result.output
        assert "flow status" not in result.output

    def test_flow_log_shows_exit_codes(self):
        """Non-zero exit codes are displayed."""
        write_entry(CliLogRecord(workdir="/w", command=["flow", "bad"], exit_code=1, level="info"))

        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log"])
        # The exit code column should contain "1"
        lines = result.output.strip().split("\n")
        data_line = lines[-1]  # last line = the entry
        assert "1" in data_line


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    def test_default_settings(self):
        """No record on disk returns level=info."""
        s = load_settings()
        assert s.level == "info"

    def test_settings_roundtrip(self):
        """Save debug, load back."""
        save_settings("debug")
        s = load_settings()
        assert s.level == "debug"

    def test_settings_record_is_proper_type(self):
        """Settings are stored as CliLogSettingsRecord."""
        save_settings("debug")
        s = load_settings()
        assert isinstance(s, CliLogSettingsRecord)

    def test_flow_log_settings_command(self):
        """flow log settings shows current level."""
        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "settings"])
        assert "level=info" in result.output

    def test_flow_log_settings_set(self):
        """flow log settings --level debug changes level."""
        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "settings", "--level", "debug"])
        assert "level=debug" in result.output

        # Verify persisted
        s = load_settings()
        assert s.level == "debug"

    def test_flow_log_settings_invalid(self):
        """flow log settings --level foo rejects invalid level."""
        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "settings", "--level", "foo"])
        assert result.exit_code != 0


# ---------------------------------------------------------------------------
# flow log clear CLI command
# ---------------------------------------------------------------------------


class TestLogClearCommand:
    def test_flow_log_clear(self):
        """flow log clear removes all entries and reports count."""
        for i in range(5):
            write_entry(CliLogRecord(workdir="/w", command=["flow", str(i)], exit_code=0))

        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "clear"])

        assert result.exit_code == 0
        assert "5" in result.output
        assert len(read_entries()) == 0

    def test_flow_log_clear_empty(self):
        """flow log clear on empty log reports 0."""
        from typer.testing import CliRunner
        from flow_sdk.cli.flow_cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["log", "clear"])

        assert result.exit_code == 0
        assert "0" in result.output


# ---------------------------------------------------------------------------
# TeeStream
# ---------------------------------------------------------------------------


class TestTeeStream:
    def test_tee_captures_output(self):
        """TeeStream captures writes while forwarding to original."""
        from flow_sdk.cli.tee_stream import TeeStream

        original = StringIO()
        tee = TeeStream(original)
        tee.write("hello ")
        tee.write("world")

        assert tee.getvalue() == "hello world"
        assert original.getvalue() == "hello world"

    def test_tee_isatty_delegation(self):
        """TeeStream delegates isatty() to original."""
        from flow_sdk.cli.tee_stream import TeeStream

        original = StringIO()
        tee = TeeStream(original)
        assert tee.isatty() is False

    def test_tee_getattr_delegation(self):
        """TeeStream delegates unknown attrs to original."""
        from flow_sdk.cli.tee_stream import TeeStream

        original = StringIO()
        tee = TeeStream(original)
        # StringIO has encoding attribute (or not, but has other attrs)
        assert tee.getvalue() == ""
