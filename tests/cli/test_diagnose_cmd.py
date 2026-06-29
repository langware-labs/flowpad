"""CLI tests for `flow diagnose`.

These exercise the CLI plumbing only — the agent run (`_run_diagnose`) is mocked,
so no worker is spawned and no DB is touched. The SDK reporter's real behavior is
covered by tests/unit/test_diagnostic_report.py.
"""
import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands.diagnose_cmd import (
    _Renderer,
    _TerminalSink,
    _extract_report_result,
)
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


def test_diagnose_cli_invokes_runner_without_a_feed_switch():
    # The runner posts a Home-Feed card for EVERY completed run, so the CLI no longer
    # passes any feed on/off switch — it just runs the diagnosis.
    with patch(_RUN, new=AsyncMock(return_value=0)) as mock_run:
        result = runner.invoke(app, ["diagnose"], input="x\n")
    assert result.exit_code == 0
    assert "create_feed_entry" not in mock_run.call_args.kwargs


# --------------------------------------------------------------------------- #
# _Renderer — narration lines + inline tool-progress dots
# --------------------------------------------------------------------------- #

def _entry(role, blocks):
    return {"message": {"role": role, "content": blocks}}


def test_renderer_shows_narration_and_pulse_not_tool_noise(capsys):
    # _Renderer emits semantic events; _TerminalSink renders them to the terminal.
    r = _Renderer(_TerminalSink())
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
    r = _Renderer(_TerminalSink())
    r.feed({"type": "system", "subtype": "init"})  # no "message" key
    r.finish()
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------- #
# _extract_report_result — completion JSON scraped from report.py's stdout
# --------------------------------------------------------------------------- #

def test_extract_report_result_parses_json_from_text():
    text = 'log line\n```json\n{"diagnosis_id": "abc", "feed_posted": false}\n```\n'
    assert _extract_report_result(text) == {"diagnosis_id": "abc", "feed_posted": False}


def test_extract_report_result_none_when_absent_or_no_id():
    assert _extract_report_result("nothing to see") is None
    assert _extract_report_result('{"feed_posted": false}') is None  # no diagnosis_id


# --------------------------------------------------------------------------- #
# _safe_echo — must not crash on a non-UTF-8 console (Windows cp1252)
# --------------------------------------------------------------------------- #

def test_safe_echo_falls_back_to_ascii_on_unencodable_console(monkeypatch):
    """A cp1252 console can't encode ▸/✓ and ``typer.echo`` raises
    UnicodeEncodeError. ``_safe_echo`` must retry with ASCII fallbacks instead of
    crashing the whole diagnose run."""
    from flow_sdk.cli.commands import diagnose_cmd

    calls: list[str] = []

    def _fake_echo(message="", nl=True, err=False):
        calls.append(message)
        if any(ord(c) > 0x7F for c in message):
            raise UnicodeEncodeError("charmap", message, 0, 1, "no mapping")

    monkeypatch.setattr(diagnose_cmd.typer, "echo", _fake_echo)
    diagnose_cmd._safe_echo("  ▸ done ✓")  # must not raise

    assert len(calls) == 2  # first attempt raised, ASCII retry succeeded
    assert all(ord(c) <= 0x7F for c in calls[1])
    assert ">" in calls[1] and "v" in calls[1]


# --------------------------------------------------------------------------- #
# _run_diagnose — must not hang when the transcript stream never self-terminates
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_run_diagnose_exits_when_recorded_even_if_stream_never_ends():
    """Regression for the Windows hang: ``_tail_status`` can fail to report
    COMPLETE (a long final report pushes the terminal markers out of its 4 KB
    tail window), so ``stream_transcript`` never returns. The command must still
    exit once report.py's result JSON appears in the stream — completion is read
    from the transcript itself, NOT a cross-process DB query or marker. The 5 s
    ``wait_for`` is a hang DETECTOR (it makes a regression fail fast) — not a
    budget to ride past the symptom.
    """
    import tempfile
    from pathlib import Path
    from unittest.mock import AsyncMock

    from flow_sdk.cli.commands import diagnose_cmd

    # await_worker_started() requires a non-empty transcript file to consider the
    # worker "started"; give the fake worker a real one so warmup passes.
    _tf = tempfile.NamedTemporaryFile(prefix="diag_warmup_", suffix=".jsonl", delete=False)
    _tf.write(b'{"type":"system"}\n')
    _tf.flush()
    _tf.close()
    _tpath = Path(_tf.name)

    class _FakeDriver:
        def transcript_path(self, _ap):
            return _tpath

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "fake-id"
            self.session_id = "fakesess"
            self.driver = _FakeDriver()

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            return None

        async def stream_transcript(self, timeout=0):
            # Narration, then report.py's result JSON via a tool_result, then never
            # terminate (the hang we fix). The JSON is the completion signal.
            yield {"message": {"role": "assistant", "content": [{"type": "text", "text": "working"}]}}
            yield {
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "content": '{"diagnosis_id": "d1", "conversation_id": null, "flow_message_id": null, "has_issue": false}',
                        }
                    ],
                }
            }
            await asyncio.sleep(3600)

        @classmethod
        async def get_by_id(cls, _id):
            return None

    with (
        patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
        patch(
            "flow_sdk.core.capabilities.discovery.ensure_discovered",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
            lambda _t: None,
        ),
        patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
        # This test is about prompt completion, not feed posting. Stub the always-on
        # feed path so the fake (non-existent) diagnosis id doesn't burn the real
        # load-retry — the run's timing must reflect completion, not a missing record.
        patch(
            "flow_sdk.cli.commands.diagnose_cmd._load_recorded_diagnosis",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.cli.commands.diagnose_cmd._post_home_feed_entry",
            new=AsyncMock(return_value=None),
        ),
    ):
        rc = await asyncio.wait_for(diagnose_cmd._run_diagnose("", 1800.0), timeout=5)
    _tpath.unlink(missing_ok=True)
    assert rc == 0


@pytest.mark.asyncio
async def test_run_diagnose_posts_loaded_diagnosis_summary_when_cross_link_fails():
    import tempfile
    from pathlib import Path

    from flow_sdk.cli.commands import diagnose_cmd

    _tf = tempfile.NamedTemporaryFile(prefix="diag_summary_", suffix=".jsonl", delete=False)
    _tf.write(b'{"type":"system"}\n')
    _tf.flush()
    _tf.close()
    _tpath = Path(_tf.name)

    class _FakeDriver:
        def transcript_path(self, _ap):
            return _tpath

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "fake-id"
            self.session_id = "fakesess"
            self.driver = _FakeDriver()

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            return None

        async def stream_transcript(self, timeout=0):
            yield {
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "content": '{"diagnosis_id": "d1", "conversation_id": null, "flow_message_id": null}',
                        }
                    ],
                }
            }

        @classmethod
        async def get_by_id(cls, _id):
            raise RuntimeError("cross-link source unavailable")

    class _FakeDiagnosis:
        @classmethod
        async def get_by_id(cls, _id):
            return SimpleNamespace(summary="diagnosis summary", title="diagnosis title")

    post_feed = AsyncMock(return_value="feed-1")

    with (
        patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
        patch(
            "flow_sdk.core.capabilities.discovery.ensure_discovered",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
            lambda _t: _FakeDiagnosis,
        ),
        patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
        patch("flow_sdk.cli.commands.diagnose_cmd._post_home_feed_entry", new=post_feed),
    ):
        rc = await diagnose_cmd._run_diagnose("x", 1800.0)

    _tpath.unlink(missing_ok=True)
    assert rc == 0
    post_feed.assert_awaited_once()
    assert post_feed.await_args.kwargs["summary"] == "diagnosis summary"


# --------------------------------------------------------------------------- #
# _await_warmup — liveness-gated start detection (no fixed wall-clock)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_run_diagnose_fails_fast_when_worker_dies_without_transcript():
    """If the worker turn ends (crash / ``claude`` binary unresolved) without
    ever producing a transcript, diagnose must surface the clear 'failed to
    start' error and exit 1 — detected via the worker leaving _PROMPT_WORKERS,
    NOT by waiting out the budget. The 5 s ``wait_for`` is a hang detector."""
    from pathlib import Path

    from flow_sdk.cli.commands import diagnose_cmd

    class _FakeDriver:
        def transcript_path(self, _ap):
            return Path("does-not-exist-never-written.jsonl")

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "dead-worker-id"
            self.session_id = "fakesess"
            self.driver = _FakeDriver()

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            # Returns without ever registering in _PROMPT_WORKERS → the turn is
            # already "ended" from warmup's perspective (the dead/never-started case).
            return None

        async def stream_transcript(self, timeout=0):
            if False:  # pragma: no cover - never iterated; warmup fails first
                yield {}

        @classmethod
        async def get_by_id(cls, _id):
            return None

    events: list[dict] = []
    with (
        patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
        patch(
            "flow_sdk.core.capabilities.discovery.ensure_discovered",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
            lambda _t: None,
        ),
        patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
    ):
        rc = await asyncio.wait_for(
            diagnose_cmd._run_diagnose("", 1800.0, emit=events.append), timeout=5
        )
    assert rc == 1
    assert any(
        e.get("type") == "error" and "produced no transcript" in e.get("text", "")
        for e in events
    )


@pytest.mark.asyncio
async def test_run_diagnose_waits_for_slow_but_alive_worker():
    """A registered (alive) worker that is slow to write its first transcript
    line must NOT be failed — warmup keeps waiting until the line appears, then
    the run completes normally. Guards the Windows cold-start regression where a
    fixed 15 s window false-failed a healthy claude."""
    import tempfile
    from pathlib import Path

    from flow_sdk.builtin.agentic_process import agentic_process as ap_mod
    from flow_sdk.cli.commands import diagnose_cmd

    _tf = tempfile.NamedTemporaryFile(prefix="diag_slow_", suffix=".jsonl", delete=False)
    _tf.close()
    _tpath = Path(_tf.name)  # exists but EMPTY (size 0) → "not started yet"
    state = {"checks": 0}

    class _FakeDriver:
        def transcript_path(self, _ap):
            # Simulate a slow cold-start: the first couple of warmup polls see an
            # empty file; only later does claude write its first line.
            state["checks"] += 1
            if state["checks"] >= 3:
                _tpath.write_bytes(b'{"type":"system"}\n')
            return _tpath

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "slow-worker-id"
            self.session_id = "fakesess"
            self.driver = _FakeDriver()

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            return None

        async def stream_transcript(self, timeout=0):
            yield {"message": {"role": "assistant", "content": [{"type": "text", "text": "working"}]}}
            yield {
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "content": '{"diagnosis_id": "d1", "conversation_id": null, "flow_message_id": null, "has_issue": false}',
                        }
                    ],
                }
            }
            await asyncio.sleep(3600)

        @classmethod
        async def get_by_id(cls, _id):
            return None

    # Mark the worker alive for the duration of the slow start.
    ap_mod._PROMPT_WORKERS["slow-worker-id"] = object()
    try:
        with (
            patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
            patch(
                "flow_sdk.core.capabilities.discovery.ensure_discovered",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
                lambda _t: None,
            ),
            patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
            # This test is about warmup/start detection, not feed posting. Stub the
            # always-on feed path so the fake diagnosis id doesn't burn the load-retry.
            patch(
                "flow_sdk.cli.commands.diagnose_cmd._load_recorded_diagnosis",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "flow_sdk.cli.commands.diagnose_cmd._post_home_feed_entry",
                new=AsyncMock(return_value=None),
            ),
        ):
            rc = await asyncio.wait_for(diagnose_cmd._run_diagnose("", 1800.0), timeout=5)
    finally:
        ap_mod._PROMPT_WORKERS.pop("slow-worker-id", None)
        _tpath.unlink(missing_ok=True)
    assert rc == 0
    assert state["checks"] >= 3  # proves warmup waited through the empty-file polls


# --------------------------------------------------------------------------- #
# Home-Feed card appearance — every completed run posts exactly one card (CLI and
# UI alike, watched or not): an issue card carrying a support conversation, or a
# no-issue summary card. Posting funnels through the single creator
# `_post_home_feed_entry` (NOT mocked here), so these assert a real, queryable card
# lands in the store.
# --------------------------------------------------------------------------- #

async def _bootstrap_local_user():
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_project,
        get_or_create_local_user,
    )

    user = await get_or_create_local_user()
    await get_or_create_local_project(desktop_user=user)


@pytest.mark.asyncio
async def test_post_home_feed_entry_makes_a_real_card_appear():
    """The single creator both surfaces use. It mints a queryable MessageSuggest
    content entity and a `new` FeedEntry pointing at it, so the card actually
    APPEARS in the store."""
    import uuid

    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.builtin.message_suggest import MessageSuggest
    from flow_sdk.cli.commands.diagnose_cmd import _post_home_feed_entry

    await _bootstrap_local_user()
    conv_id, msg_id = str(uuid.uuid4()), str(uuid.uuid4())

    fid = await _post_home_feed_entry(
        conversation_id=conv_id,
        flow_message_id=msg_id,
        summary="Cleared a stale server.lock; the backend starts now.",
    )
    assert fid

    entry = await FeedEntry.get_by_id(fid)
    assert entry is not None
    assert entry.feed_status == FeedStatus.NEW.value  # only `new` renders in the Feed
    assert entry.data["type_id"].startswith("message_suggest-")
    suggest = await MessageSuggest.get_by_id(entry.data["type_id"].split("-", 1)[1])
    assert suggest is not None
    assert suggest.conversation_id == conv_id
    assert suggest.flow_message_id == msg_id
    assert suggest.message_text == "Cleared a stale server.lock; the backend starts now."


@pytest.mark.asyncio
async def test_post_home_feed_entry_no_issue_card_has_summary_no_conversation():
    """The no-issue variant of the creator (posted for every clean run, so the result
    still reaches the feed): a `new` FeedEntry pointing at MessageSuggest content
    carrying the summary as its body, a non-error header, and NO conversation."""
    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.builtin.message_suggest import MessageSuggest
    from flow_sdk.cli.commands.diagnose_cmd import _post_home_feed_entry

    await _bootstrap_local_user()
    fid = await _post_home_feed_entry(summary="All healthy — typing works; nothing to fix.")
    assert fid

    entry = await FeedEntry.get_by_id(fid)
    assert entry is not None
    assert entry.feed_status == FeedStatus.NEW.value
    assert entry.data["type_id"].startswith("message_suggest-")
    suggest = await MessageSuggest.get_by_id(entry.data["type_id"].split("-", 1)[1])
    assert suggest is not None
    assert suggest.message_text == "All healthy — typing works; nothing to fix."
    assert not suggest.conversation_id  # no issue -> no support conversation
    assert not suggest.flow_message_id
    assert "error came up" not in suggest.text  # not the issue header


@pytest.mark.parametrize(
    "label,has_issue,expect_conversation",
    [
        # Every completed run posts a card. An issue run's card carries the support
        # conversation (Report/Forward buttons); a no-issue run's card is a summary card.
        ("issue", True, True),
        ("no_issue", False, False),
    ],
)
@pytest.mark.asyncio
async def test_feed_card_always_appears(label, has_issue, expect_conversation):
    """End-to-end at the runner layer: a real Home-Feed card appears for EVERY
    completed run — there is no longer a switch. An issue run yields an issue card
    carrying its support conversation; a no-issue run yields a summary card with no
    conversation. `_post_home_feed_entry` is NOT mocked, so the card's existence (and
    whether it carries a conversation) is proven by loading it back from the store."""
    import tempfile
    import uuid
    from pathlib import Path
    from unittest.mock import AsyncMock

    from flow_sdk.builtin.feed_entry import FeedEntry, FeedStatus
    from flow_sdk.builtin.message_suggest import MessageSuggest
    from flow_sdk.cli.commands import diagnose_cmd

    await _bootstrap_local_user()
    diag_id = str(uuid.uuid4())
    if has_issue:
        conv_id, msg_id = str(uuid.uuid4()), str(uuid.uuid4())
        report_json = (
            f'{{"diagnosis_id": "{diag_id}", "conversation_id": "{conv_id}", '
            f'"flow_message_id": "{msg_id}", "has_issue": true}}'
        )
    else:
        conv_id = msg_id = None
        report_json = (
            f'{{"diagnosis_id": "{diag_id}", "conversation_id": null, '
            f'"flow_message_id": null, "has_issue": false}}'
        )

    _tf = tempfile.NamedTemporaryFile(prefix="diag_card_", suffix=".jsonl", delete=False)
    _tf.write(b'{"type":"system"}\n')
    _tf.flush()
    _tf.close()
    _tpath = Path(_tf.name)

    class _FakeDriver:
        def transcript_path(self, _ap):
            return _tpath

    class _FakeAP:
        def __init__(self, **_kw):
            self.id = "card-worker-id"
            self.session_id = "fakesess"
            self.driver = _FakeDriver()

        def enable_assistant(self):
            pass

        async def prompt(self, _text):
            return None

        async def stream_transcript(self, timeout=0):
            # report.py prints its result JSON, then the stream ends cleanly so the
            # feed-decision runs immediately.
            yield {
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "content": report_json}],
                }
            }

        @classmethod
        async def get_by_id(cls, _id):
            return None

    events: list[dict] = []
    with (
        patch("flow_sdk.builtin.agentic_process.AgenticProcess", _FakeAP),
        patch(
            "flow_sdk.core.capabilities.discovery.ensure_discovered",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.fs_store.schema_registry.SchemaRegistry.get_entity_cls",
            lambda _t: None,
        ),
        patch("flow_sdk.migrations.runner._bootstrap_local", new=AsyncMock(return_value=None)),
        patch(
            "flow_sdk.cli.commands.diagnose_cmd._load_recorded_diagnosis",
            new=AsyncMock(
                return_value=SimpleNamespace(
                    summary="diagnosis summary",
                    title="diagnosis title",
                )
            ),
        ),
    ):
        rc = await asyncio.wait_for(
            diagnose_cmd._run_diagnose("", 1800.0, emit=events.append),
            timeout=5,
        )
    _tpath.unlink(missing_ok=True)

    assert rc == 0
    done = next(e for e in events if e.get("type") == "done")
    assert done["feed_posted"] is True  # a card always appears now
    fid = done["feed_entry_id"]
    assert fid, "expected a Home-Feed card to be posted"
    entry = await FeedEntry.get_by_id(fid)
    assert entry is not None, "the posted card must actually exist in the store"
    assert entry.feed_status == FeedStatus.NEW.value
    assert entry.data["type_id"].startswith("message_suggest-")
    suggest = await MessageSuggest.get_by_id(entry.data["type_id"].split("-", 1)[1])
    assert suggest is not None
    if expect_conversation:
        assert suggest.conversation_id == conv_id
        assert suggest.flow_message_id == msg_id
    else:
        assert not suggest.conversation_id  # no-issue summary card
        assert not suggest.flow_message_id
