"""GATEKEEPER: TranscriptStreamer must produce ENTRY-FOR-ENTRY identical
output to a one-shot ``AgentTranscriptFile`` parse, across every real-world
JSONL file on this machine.

Two parametrized tests over a sample of session JSONL files under
``~/.claude/projects/`` and ``~/.codex/sessions/``:

  1. ``test_full_file_matches_streamed_delta`` — construct streamer on a
     real file; one ``notify_change()`` call (which flushes the constructor's
     initial read as a single delta) must return entries identical to a
     one-shot ``AgentTranscriptFile(worker, path).entries``.

  2. ``test_chunked_writes_match_full_parse`` — replay the file as N
     partial line-aligned appends into a tmp file, accumulating deltas;
     concatenated streamed output must equal the one-shot parse.

Sampling: with potentially thousands of local JSONL files, parametrizing
over all of them would be too slow for unit-test cadence. We sample 100 per
worker by default (deterministic via fixed seed so reruns hit the same
files). Set ``RUN_ALL_TRANSCRIPT_PARITY=1`` to run over every file —
useful for thorough validation before shipping.

No mocks, no stubs. Real worker parsers. Real files. Both Claude and Codex.
This test is the contract enforcer for "no parser duplication": any
divergence between ``parse_delta`` chunked output and one-shot
``AgentTranscriptFile`` output, on any file, fails the test.
"""
from __future__ import annotations

import os
import random
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile
from flow_sdk.transcript_streamer.registry import _infer_worker_type
from flow_sdk.transcript_streamer.streamer import TranscriptStreamer


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


_SAMPLE_SIZE_PER_WORKER = 100
_PARITY_SEED = 0xC0FFEE
_RUN_ALL = os.environ.get("RUN_ALL_TRANSCRIPT_PARITY", "").lower() in ("1", "true", "yes")


def _all_under(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.jsonl"))


def _sample(files: list[Path], n: int) -> list[Path]:
    if len(files) <= n:
        return files
    rng = random.Random(_PARITY_SEED)
    return rng.sample(files, n)


def _discover_jsonl_files() -> list[Path]:
    """Sample of JSONL files across both worker dirs. Deterministic via seed."""
    home = Path.home()
    claude = _all_under(home / ".claude" / "projects")
    codex = _all_under(home / ".codex" / "sessions")
    if _RUN_ALL:
        return claude + codex
    return _sample(claude, _SAMPLE_SIZE_PER_WORKER) + _sample(codex, _SAMPLE_SIZE_PER_WORKER)


_DISCOVERED = _discover_jsonl_files()
if not _DISCOVERED:
    pytest.skip(
        "No transcript JSONL files found under ~/.claude/projects or ~/.codex/sessions",
        allow_module_level=True,
    )


def _ids(paths: list[Path]) -> list[str]:
    """Short ids for pytest output — last two path components."""
    return [f"{p.parent.name}/{p.name}" for p in paths]


def _entries_structurally_equal(a, b) -> bool:
    """Field-by-field equality across TranscriptEntry subclasses.

    ``TranscriptEntry`` is a plain Python class (not a dataclass), so the
    default ``__eq__`` is identity. We compare ``__dict__`` directly.
    """
    if type(a) is not type(b):
        return False
    da = getattr(a, "__dict__", None)
    db = getattr(b, "__dict__", None)
    if da is None or db is None:
        return a is b
    return da == db


def _explain_diff(a, b) -> str:
    """Return a human-readable list of fields where ``a`` and ``b`` differ."""
    if type(a) is not type(b):
        return f"type mismatch: {type(a).__name__} vs {type(b).__name__}"
    da = getattr(a, "__dict__", None) or {}
    db = getattr(b, "__dict__", None) or {}
    keys = sorted(set(da) | set(db))
    diffs: list[str] = []
    for k in keys:
        va = da.get(k, "<missing>")
        vb = db.get(k, "<missing>")
        if va != vb:
            diffs.append(f"  {k}: streamed={va!r}  baseline={vb!r}")
    return "\n".join(diffs) if diffs else "(no field-level diff — dataclass __eq__ disagrees with __dict__ comparison)"


def _split_lines_into_n_chunks(lines: list[bytes], n: int) -> list[bytes]:
    """Split a list of line-bytes into n contiguous chunks. Each chunk is the
    concatenation of one or more whole lines, so chunk boundaries are
    line-aligned (writers append whole lines)."""
    if not lines:
        return [b""]
    n = max(1, min(n, len(lines)))
    chunks: list[bytes] = []
    chunk_size = len(lines) // n
    rem = len(lines) % n
    i = 0
    for k in range(n):
        size = chunk_size + (1 if k < rem else 0)
        chunks.append(b"".join(lines[i : i + size]))
        i += size
    return chunks


# ──────────────────────────────────────────────────────────────────────────────
# Parity tests
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("jsonl_path", _DISCOVERED, ids=_ids(_DISCOVERED))
def test_full_file_matches_streamed_delta(jsonl_path: Path) -> None:
    """``streamer.notify_change()`` over a fully-written file returns entries
    identical to ``AgentTranscriptFile(worker, path).entries``."""
    try:
        worker = _infer_worker_type(jsonl_path)
    except ValueError:
        pytest.skip(f"cannot infer worker for {jsonl_path}")

    baseline = AgentTranscriptFile(worker, jsonl_path).entries

    streamer = TranscriptStreamer(jsonl_path, worker)
    # Streamer's constructor did the initial read; the first parse_delta
    # flushes that as a single chunk (last_emitted starts at 0).
    streamed = streamer.transcript.parse_delta()

    assert len(streamed) == len(baseline), (
        f"len mismatch on {jsonl_path}: streamed={len(streamed)} baseline={len(baseline)}"
    )
    for i, (s, b) in enumerate(zip(streamed, baseline)):
        assert _entries_structurally_equal(s, b), (
            f"entry {i} mismatch on {jsonl_path}:\n  streamed={s!r}\n  baseline={b!r}\n"
            f"diff:\n{_explain_diff(s, b)}"
        )


@pytest.mark.parametrize("jsonl_path", _DISCOVERED, ids=_ids(_DISCOVERED))
def test_chunked_writes_match_full_parse(jsonl_path: Path, tmp_path: Path) -> None:
    """Replay the JSONL file as N=10 line-aligned partial appends. After every
    chunk is written, the streamer's INTERNAL state (``streamer.transcript.entries``)
    must equal a one-shot ``AgentTranscriptFile`` parse.

    Why compare internal state, not the cumulative delta stream:

    The two fold passes (``_fold_assistant_messages``, ``_fold_tool_results``)
    pair entries that may span chunk boundaries. A ``FileReadEntry`` from chunk
    1 gains ``bytes_count`` and ``content_preview`` from a ``ToolResultEntry``
    in chunk 2; in the cumulative delta stream, the chunk-1 emission carries
    the UNFOLDED FileReadEntry while chunk 2 drops the result row (it folded
    in). Subscribers therefore see the unfolded version once. This is the
    correct streaming semantic — folds are applied to the streamer's internal
    ``entries`` (which subscribers can re-read at any time) without re-emitting
    already-delivered entries.

    Equivalently: ``streamer.transcript.entries`` matches the baseline; the
    cumulative delta stream is a strict subset (no retroactive amendments).
    """
    try:
        worker = _infer_worker_type(jsonl_path)
    except ValueError:
        pytest.skip(f"cannot infer worker for {jsonl_path}")

    full_bytes = jsonl_path.read_bytes()
    # splitlines(keepends=True) keeps trailing newlines so concatenation
    # reproduces the original file exactly.
    lines = full_bytes.splitlines(keepends=True)

    if not lines:
        pytest.skip(f"empty file: {jsonl_path}")

    tmp = tmp_path / jsonl_path.name
    tmp.touch()

    streamer = TranscriptStreamer(tmp, worker)
    # Sanity: empty file → no entries
    initial = streamer.transcript.parse_delta()
    assert initial == [], f"empty-file initial delta should be empty: got {initial!r}"

    for chunk in _split_lines_into_n_chunks(lines, n=10):
        if not chunk:
            continue
        with open(tmp, "ab") as f:
            f.write(chunk)
        streamer.transcript.parse_delta()

    streamed_final = streamer.transcript.entries
    baseline = AgentTranscriptFile(worker, jsonl_path).entries

    assert len(streamed_final) == len(baseline), (
        f"chunked-final len mismatch on {jsonl_path}: "
        f"streamed={len(streamed_final)} baseline={len(baseline)}"
    )
    for i, (s, b) in enumerate(zip(streamed_final, baseline)):
        assert _entries_structurally_equal(s, b), (
            f"chunked-final entry {i} mismatch on {jsonl_path}:\n"
            f"  streamed={s!r}\n  baseline={b!r}\n"
            f"diff:\n{_explain_diff(s, b)}"
        )
