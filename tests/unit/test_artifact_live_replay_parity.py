"""Replay parity across workers — a reloaded artifact chip must match the live one.

An artifact is registered by an explicit ``flow artifact`` CLI call, so the chip
the user sees is built from a ``FlowCommandEntry``. That entry has to survive a
reload identically on every harness, or an artifact registered on one worker
silently loses its chip when the page refreshes.

Derivation itself is already worker-agnostic (``derive.py``, covered by
``test_flow_command_derive.py``). What is NOT symmetric is the *replay envelope*:
each driver has its own path from a parsed entry back to ``FlowData``, and only
some of them wrap it in a ``ProcessEntry``. This module pins that envelope.

Deliberately goes through each driver's REAL replay loader rather than
``entry.to_flow_data()`` — the existing parity test in
``test_codex_copilot_event_to_flowdata_derive.py`` compares against the bare
entry conversion, which is precisely why the copilot gap survived.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
    entry_to_flowdata as claude_entry_to_flowdata,
)
from flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history import (
    load_transcript_history as codex_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import (
    load_transcript_history as copilot_load_transcript_history,
)
from flow_sdk.transcript_analyzer import AgentTranscriptFile

pytestmark = pytest.mark.timeout(15)  # do not increase timeout without approval

_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"
_COMMAND = f"flow artifact entity {_TYPE_ID}"


# ── one `flow artifact` invocation, in each vendor's own transcript shape ──────


def _write_claude(path: Path, command: str) -> Path:
    line = {
        "type": "assistant",
        "uuid": "00000000-0000-4000-8000-0000000001a1",
        "sessionId": "s1",
        "timestamp": "2026-07-23T10:00:01.000Z",
        "message": {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-4-7",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": {"command": command},
                }
            ],
        },
    }
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    return path


def _write_codex(path: Path, command: str) -> Path:
    line = {
        "type": "item.completed",
        "item": {
            "id": "item_1",
            "type": "command_execution",
            "command": command,
            "aggregated_output": "ok\n",
            "exit_code": 0,
        },
        "timestamp": "2026-07-23T10:00:01.000Z",
    }
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    return path


def _write_copilot(path: Path, command: str) -> Path:
    line = {
        "type": "assistant.message",
        "data": {
            "messageId": "m1",
            "model": "claude-haiku-4.5",
            "content": "",
            "toolRequests": [
                {
                    "toolCallId": "toolu_1",
                    "name": "bash",
                    "type": "function",
                    "arguments": {"command": command},
                }
            ],
        },
    }
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    return path


# ── each driver's real replay production path ─────────────────────────────────


def _claude_replay(path: Path):
    # Claude has no path-based loader (``load_session_history`` resolves a
    # session id); its per-entry converter IS the replay path.
    return [claude_entry_to_flowdata(e) for e in AgentTranscriptFile("claude", path).entries]


def _codex_replay(path: Path):
    return codex_load_transcript_history(path)


def _copilot_replay(path: Path):
    return copilot_load_transcript_history(path)


WORKERS = pytest.mark.parametrize(
    ("worker", "write", "replay"),
    [
        ("claude", _write_claude, _claude_replay),
        ("codex", _write_codex, _codex_replay),
        ("copilot", _write_copilot, _copilot_replay),
    ],
    ids=["claude", "codex", "copilot"],
)


def _artifact_frame(frames):
    """The one frame a chip would render for the `flow artifact` call."""
    hits = [fd for fd in frames if "flow-verb" in (fd.attributes or {})]
    assert hits, "no flow_command frame in the replayed history"
    return hits[0]


# ── the envelope contract ─────────────────────────────────────────────────────


@WORKERS
def test_replay_derives_the_artifact_command(tmp_path, worker, write, replay):
    """Derivation survives replay on every worker — the part that already works."""
    fd = _artifact_frame(replay(write(tmp_path / f"{worker}.jsonl", _COMMAND)))

    assert fd.attributes["flow-verb"] == "artifact"
    assert fd.attributes["flow-target"] == _TYPE_ID


@WORKERS
def test_replay_frame_carries_observation_kind(tmp_path, worker, write, replay):
    """``observation-kind`` is the live/replay discriminator consumers dedupe on."""
    fd = _artifact_frame(replay(write(tmp_path / f"{worker}.jsonl", _COMMAND)))

    assert fd.attributes.get("observation-kind") == "replay"


@WORKERS
def test_replay_frame_carries_process_entry(tmp_path, worker, write, replay):
    """The typed entry rides on ``process_entry`` — the chip reads it first."""
    fd = _artifact_frame(replay(write(tmp_path / f"{worker}.jsonl", _COMMAND)))

    assert fd.process_entry, "replayed frame lost its ProcessEntry wrapper"
    assert fd.process_entry["observation_kind"] == "replay"
    assert fd.process_entry["transcript_entry"]["kind"] == "flow_command"


@WORKERS
def test_replay_frame_carries_subtype(tmp_path, worker, write, replay):
    """``subtype`` is what ``describeEvent`` falls back to when reading a frame."""
    fd = _artifact_frame(replay(write(tmp_path / f"{worker}.jsonl", _COMMAND)))

    assert fd.attributes.get("subtype") == "flow_command"


def test_replay_envelopes_agree_across_workers(tmp_path):
    """No worker may produce a structurally poorer replay frame than its peers.

    This is the matrix assertion: whatever envelope keys one harness stamps on a
    replayed artifact chip, all of them must. A worker missing a key here means
    the same artifact renders differently depending on who produced it.
    """
    envelopes = {}
    for worker, write, replay in (
        ("claude", _write_claude, _claude_replay),
        ("codex", _write_codex, _codex_replay),
        ("copilot", _write_copilot, _copilot_replay),
    ):
        fd = _artifact_frame(replay(write(tmp_path / f"{worker}.jsonl", _COMMAND)))
        envelopes[worker] = {
            "attribute_keys": {
                k for k in fd.attributes if k in {"element-type", "data-type", "subtype", "observation-kind"}
            },
            "has_process_entry": bool(fd.process_entry),
        }

    expected = envelopes["codex"]
    assert envelopes["claude"] == expected, f"claude replay envelope diverges: {envelopes}"
    assert envelopes["copilot"] == expected, (
        "copilot replay envelope diverges — "
        "cli_drivers/copilot/session_history.load_transcript_history calls bare "
        "entry.to_flow_data(), unlike claude and codex which wrap in a ProcessEntry. "
        f"{envelopes}"
    )
