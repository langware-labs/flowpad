"""A delta folds the NEW lines only — it never reprocesses the session.

``AgentTranscriptFile._refold`` used to copy, re-fold and re-derive every
retained entry on every appended line (0.4–0.6 s per line on an 85 MB
session). Now the fold state survives between deltas and a new line touches
only the entries it folds into, copy-on-write. These tests pin the three
observables of that contract, through the real ``TranscriptStreamer`` path:

  (a) chunked appends equal a one-shot parse (late assistant row, late tool
      result on a derived flow command, Claude keep-last usage dedup);
  (b) per-append work is bounded — counted, not timed: zero ``copy.copy``
      for an unrelated line, one copy + one ``_derive_from`` when a result
      lands on an old call;
  (c) a write-order inversion (codex transport mirror BEFORE its canonical
      result, the fixture ``test_codex_parser.py`` pins) takes the full
      refold fallback and still equals the one-shot parse;
  (d) entries published by an earlier delta are never mutated.

Real parsers, real tmp JSONL, no mocks of the fold — the counters wrap the
two helpers the fold calls so the test sees how often they ran.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer import transcript as transcript_module
from flow_sdk.transcript_analyzer.entries import (
    AssistantMessageEntry,
    FlowCommandEntry,
    ShellCommandEntry,
    ToolResultEntry,
    UsageEntry,
)
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile
from flow_sdk.transcript_streamer.streamer import TranscriptStreamer

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

_SID = "11111111-1111-4111-8111-111111111111"
_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"
_FLOW_COMMAND = f"flow show entity {_TYPE_ID}"


# ── Claude JSONL shapes ──────────────────────────────────────────────────────


def _user(uuid: str, text: str) -> dict:
    return {
        "uuid": uuid, "sessionId": _SID, "type": "user",
        "timestamp": "2026-07-23T10:00:00Z",
        "message": {"role": "user", "content": text},
    }


def _assistant_text(uuid: str, msg_id: str, text: str, *, usage: dict | None = None) -> dict:
    message = {
        "id": msg_id, "role": "assistant", "model": "claude-opus-4-8",
        "content": [{"type": "text", "text": text}],
    }
    if usage is not None:
        message["usage"] = usage
    return {
        "uuid": uuid, "sessionId": _SID, "type": "assistant",
        "timestamp": "2026-07-23T10:00:01Z", "message": message,
    }


def _bash(uuid: str, msg_id: str, tuid: str, command: str) -> dict:
    return {
        "uuid": uuid, "sessionId": _SID, "type": "assistant",
        "timestamp": "2026-07-23T10:00:01Z",
        "message": {
            "id": msg_id, "role": "assistant", "model": "claude-opus-4-8",
            "content": [{"type": "tool_use", "id": tuid, "name": "Bash", "input": {"command": command}}],
        },
    }


def _result(uuid: str, tuid: str, stdout: str, exit_code: int = 0) -> dict:
    return {
        "uuid": uuid, "sessionId": _SID, "type": "user",
        "timestamp": "2026-07-23T10:00:02Z",
        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tuid, "content": stdout}]},
        "toolUseResult": {"exitCode": exit_code, "stdout": stdout},
    }


def _session_lines(filler: int = 200) -> list[dict]:
    """A session with every fold shape: a multi-row assistant message, a
    ``flow`` command (derives a FlowCommandEntry) left WITHOUT its result,
    and ``filler`` ordinary call+result pairs (each folds to ONE entry) so
    the list is a few hundred entries — the size at which reprocessing
    would show up in the counts."""
    lines = [
        _user("u0", "show it"),
        _assistant_text("a0", "msg_0", "first row"),
        _bash("a1", "msg_1", "toolu_flow", _FLOW_COMMAND),
    ]
    for i in range(filler):
        lines.append(_bash(f"b{i}", f"msg_b{i}", f"toolu_b{i}", f"echo {i}"))
        lines.append(_result(f"r{i}", f"toolu_b{i}", f"{i}\n"))
    return lines


def _write(path: Path, lines: list[dict]) -> None:
    path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")


def _append(path: Path, *lines: dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def _same(streamed: list, baseline: list) -> None:
    """Entry-for-entry structural equality (entries are plain classes)."""
    assert len(streamed) == len(baseline)
    for i, (s, b) in enumerate(zip(streamed, baseline)):
        assert type(s) is type(b), i
        assert s.__dict__ == b.__dict__, (i, s.__dict__, b.__dict__)


class _Counter:
    """Counts the two calls that a reprocessing fold makes N times per delta."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.copies = 0
        self.derives = 0
        real_copy, real_derive = transcript_module.copy.copy, transcript_module._derive_from

        def counted_copy(obj):
            self.copies += 1
            return real_copy(obj)

        def counted_derive(*args, **kwargs):
            self.derives += 1
            return real_derive(*args, **kwargs)

        monkeypatch.setattr(transcript_module, "copy", type("copyproxy", (), {"copy": staticmethod(counted_copy)}))
        monkeypatch.setattr(transcript_module, "_derive_from", counted_derive)

    def reset(self) -> None:
        self.copies = self.derives = 0


# ── (a) chunked appends equal a one-shot parse ───────────────────────────────


@pytest.mark.asyncio
async def test_chunked_appends_equal_one_shot_parse(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(path, _session_lines())
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()  # history flush

    # One delta each: a late row of msg_0, the result of the flow command
    # (its derived chip must pick up the exit code), an unrelated prompt.
    for line in (
        _assistant_text("a2", "msg_0", "second row"),
        _result("rf", "toolu_flow", "displayed", exit_code=0),
        _user("u9", "thanks"),
    ):
        _append(path, line)
        await streamer.notify_change()

    entries = streamer.transcript.entries
    _same(entries, AgentTranscriptFile("claude", path).entries)

    [msg0] = [e for e in entries if isinstance(e, AssistantMessageEntry) and e.entry_id == "msg_0"]
    assert msg0.text == "first row\nsecond row"
    [flow] = [e for e in entries if isinstance(e, FlowCommandEntry)]
    assert flow.exit_code == 0 and flow.stdout_preview == "displayed"
    assert not any(isinstance(e, ToolResultEntry) and e.tool_use_id == "toolu_flow" for e in entries)


@pytest.mark.asyncio
async def test_claude_keep_last_usage_dedup_crosses_a_delta_boundary(tmp_path: Path) -> None:
    """The Claude parser zeroes the EARLIER snapshot's usage rows in place when
    a message.id repeats. Those rows are shared with ``entries`` (never fold
    targets), so the amendment must show through a delta exactly as a
    one-shot parse shows it."""
    path = tmp_path / "session.jsonl"
    usage_1 = {"input_tokens": 10, "output_tokens": 32}
    usage_2 = {"input_tokens": 10, "output_tokens": 64}
    _write(path, [_user("u0", "hi"), _assistant_text("a0", "msg_0", "draft", usage=usage_1)])
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()

    _append(path, _assistant_text("a1", "msg_0", "final", usage=usage_2))
    await streamer.notify_change()

    entries = streamer.transcript.entries
    _same(entries, AgentTranscriptFile("claude", path).entries)
    outputs = [e.count for e in entries if isinstance(e, UsageEntry) and e.io == "output"]
    assert outputs == [0, 64]


# ── (b) per-append work is bounded ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_unrelated_line_copies_nothing_and_derives_only_itself(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "session.jsonl"
    _write(path, _session_lines())
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()
    assert len(streamer.transcript.entries) > 200
    counter = _Counter(monkeypatch)

    # First delta builds the fold indexes once; it still copies nothing.
    _append(path, _user("u9", "one more"))
    await streamer.notify_change()
    assert (counter.copies, counter.derives) == (0, 1)

    counter.reset()
    _append(path, _user("u10", "and another"))
    await streamer.notify_change()
    assert (counter.copies, counter.derives) == (0, 1)


@pytest.mark.asyncio
async def test_result_on_an_old_call_copies_that_call_only(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "session.jsonl"
    _write(path, _session_lines())
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()
    counter = _Counter(monkeypatch)

    # The flow command has a derived child, so its result costs one copy
    # (the call) and one derive (regenerating that chain) — not N of either.
    _append(path, _result("rf", "toolu_flow", "displayed"))
    await streamer.notify_change()
    assert (counter.copies, counter.derives) == (1, 1)

    counter.reset()
    # A second row of an old assistant message: one copy, no derivation
    # (nothing derives from an assistant message).
    _append(path, _assistant_text("a2", "msg_0", "second row"))
    await streamer.notify_change()
    assert (counter.copies, counter.derives) == (1, 0)


# ── (c) write-order inversions take the full refold and stay exact ───────────


@pytest.mark.asyncio
async def test_codex_mirror_before_canonical_falls_back_to_full_refold(tmp_path: Path) -> None:
    """``test_codex_parser.test_patch_apply_end_transport_mirror_is_not_an_orphan_result``
    pins the one-shot result of this order; here the same three lines arrive
    one delta at a time. The mirror is kept while it is the only record; the
    canonical line can only drop it by seeing both at once — the full fold."""
    path = tmp_path / "rollout.jsonl"
    _write(path, [{"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}}])
    streamer = TranscriptStreamer(path, "codex")
    await streamer.notify_change()

    _append(path, {
        "timestamp": "t1", "type": "event_msg",
        "payload": {
            "type": "patch_apply_end", "call_id": "call-77", "success": True,
            "stdout": "Success. Updated the following files:\nM b.py\n", "stderr": "",
        },
    })
    await streamer.notify_change()
    assert streamer.transcript._fold is not None  # incremental path took it
    [mirror] = [e for e in streamer.transcript.entries if isinstance(e, ToolResultEntry)]
    assert mirror.is_transport_mirror

    _append(path, {
        "timestamp": "t2", "type": "response_item",
        "payload": {"type": "custom_tool_call_output", "call_id": "call-77", "output": "canonical output"},
    })
    await streamer.notify_change()
    assert streamer.transcript._fold is None  # full refold ran (and reset the state)

    entries = streamer.transcript.entries
    _same(entries, AgentTranscriptFile("codex", path).entries)
    [result] = [e for e in entries if isinstance(e, ToolResultEntry)]
    assert result.tool_output == "canonical output"


@pytest.mark.asyncio
async def test_call_after_its_result_falls_back_to_full_refold(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(path, [_user("u0", "go"), _result("r0", "toolu_late", "late output")])
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()

    _append(path, _user("u1", "still waiting"))
    await streamer.notify_change()
    assert streamer.transcript._fold is not None

    _append(path, _bash("a0", "msg_0", "toolu_late", "echo late"))
    await streamer.notify_change()
    assert streamer.transcript._fold is None

    entries = streamer.transcript.entries
    _same(entries, AgentTranscriptFile("claude", path).entries)
    [cmd] = [e for e in entries if isinstance(e, ShellCommandEntry)]
    assert cmd.stdout_preview == "late output"
    assert not any(isinstance(e, ToolResultEntry) for e in entries)


# ── (d) a published entry is never mutated ───────────────────────────────────


@pytest.mark.asyncio
async def test_entries_published_by_an_earlier_delta_are_not_mutated(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(path, _session_lines())
    streamer = TranscriptStreamer(path, "claude")
    await streamer.notify_change()

    published = streamer.transcript.entries
    snapshot = [(e, dict(e.__dict__)) for e in published]
    [old_call] = [
        e for e in published
        if isinstance(e, ShellCommandEntry) and not e.virtual and e.tool_use_id == "toolu_flow"
    ]
    assert old_call.exit_code is None

    _append(path, _result("rf", "toolu_flow", "displayed", exit_code=3))
    await streamer.notify_change()
    current = streamer.transcript.entries

    # The list the reader holds is untouched, object by object.
    assert streamer.transcript.entries is not published
    for entry, fields in snapshot:
        assert entry.__dict__ == fields
    assert old_call.exit_code is None

    # The new list swaps in a copy at the same index; every other row IS the
    # same object (nothing was reprocessed).
    idx = published.index(old_call)
    assert current[idx] is not old_call
    assert current[idx].exit_code == 3 and current[idx].id == old_call.id
    [chip] = [e for e in current if isinstance(e, FlowCommandEntry)]
    assert chip.exit_code == 3
    for i, entry in enumerate(published):
        if i == idx or entry.virtual and entry.derived_from == old_call.id:
            continue
        assert current[i] is entry, i
