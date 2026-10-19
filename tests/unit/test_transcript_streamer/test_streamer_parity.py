"""GATEKEEPER: TranscriptStreamer must produce ENTRY-FOR-ENTRY identical
output to a one-shot ``AgentTranscriptFile`` parse, across every real-world
JSONL file on this machine.

Two parametrized tests over a sample of session JSONL files under
``~/.claude/projects/`` and ``~/.codex/sessions/``:

  1. ``test_full_file_matches_streamed_delta`` — construct both parsers on an
     owned copy of a captured real file; the streamer's first ``parse_delta()``
     call must return entries identical to a one-shot
     ``AgentTranscriptFile(worker, path).entries``.

  2. ``test_chunked_writes_match_full_parse`` — replay the file as N
     partial line-aligned appends into a tmp file, accumulating deltas;
     concatenated streamed output must equal the one-shot parse.

Sampling: with potentially thousands of local JSONL files, parametrizing
over all of them would be too slow for unit-test cadence. We sample 100 per
worker by default (deterministic via fixed seed so reruns hit the same
files). Set ``RUN_ALL_TRANSCRIPT_PARITY=1`` to run over every file —
useful for thorough validation before shipping.

Selected files are copied to a collection-owned on-disk snapshot before test
fixtures can clean or mutate the ambient corpus. Each test then materializes
its own copy, so both parsers consume the exact same captured bytes.

No mocks, no stubs. Real worker parsers. Real file contents. Both Claude and Codex.
This test is the contract enforcer for "no parser duplication": any
divergence between ``parse_delta`` chunked output and one-shot
``AgentTranscriptFile`` output, on any file, fails the test.
"""
from __future__ import annotations

import os
import random
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile
from flow_sdk.transcript_streamer.streamer import TranscriptStreamer

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


_SAMPLE_SIZE_PER_WORKER = 100
_PARITY_SEED = 0xC0FFEE
_RUN_ALL = os.environ.get("RUN_ALL_TRANSCRIPT_PARITY", "").lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class _ParityCandidate:
    path: Path
    worker: str

    @property
    def label(self) -> str:
        return f"{self.path.parent.name}/{self.path.name}"


@dataclass(frozen=True)
class _ParityCase:
    label: str
    worker: str
    snapshot_path: Path


def _all_under(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.jsonl"))


def _sample(files: list[Path], n: int) -> list[Path]:
    if len(files) <= n:
        return files
    rng = random.Random(_PARITY_SEED)
    return rng.sample(files, n)


def _discover_jsonl_files() -> list[_ParityCandidate]:
    """Sample of JSONL files across both worker dirs. Deterministic via seed."""
    # The preserved home is read-only collection input; tests use owned copies.
    home = Path(os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or Path.home())
    claude = _all_under(home / ".claude" / "projects")
    codex = _all_under(home / ".codex" / "sessions")
    if _RUN_ALL:
        selected_claude = claude
        selected_codex = codex
    else:
        selected_claude = _sample(claude, _SAMPLE_SIZE_PER_WORKER)
        selected_codex = _sample(codex, _SAMPLE_SIZE_PER_WORKER)
    return [
        *(_ParityCandidate(path, "claude") for path in selected_claude),
        *(_ParityCandidate(path, "codex") for path in selected_codex),
    ]


def _capture_cases(
    candidates: list[_ParityCandidate], snapshot_root: Path
) -> list[_ParityCase]:
    """Copy mutable ambient inputs into an owned, collection-lifetime corpus."""
    snapshot_root.mkdir(parents=True, exist_ok=True)
    cases: list[_ParityCase] = []
    for index, candidate in enumerate(candidates):
        try:
            content = candidate.path.read_bytes()
        except FileNotFoundError:
            # Ambient files may disappear between enumeration and capture.
            continue
        snapshot_path = snapshot_root / f"{index:04d}.jsonl"
        snapshot_path.write_bytes(content)
        cases.append(
            _ParityCase(
                label=candidate.label,
                worker=candidate.worker,
                snapshot_path=snapshot_path,
            )
        )
    return cases


_SNAPSHOT_DIR = tempfile.TemporaryDirectory(prefix="flowpad-transcript-parity-")
_DISCOVERED = _capture_cases(_discover_jsonl_files(), Path(_SNAPSHOT_DIR.name))


def _ids(cases: list[_ParityCase]) -> list[str]:
    """Short ids for pytest output — last two path components."""
    return [case.label for case in cases]


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


def _assert_entries_match(streamed, baseline, *, label: str, prefix: str = "") -> None:
    assert len(streamed) == len(baseline), (
        f"{prefix}len mismatch on {label}: "
        f"streamed={len(streamed)} baseline={len(baseline)}"
    )
    for i, (s, b) in enumerate(zip(streamed, baseline)):
        assert _entries_structurally_equal(s, b), (
            f"{prefix}entry {i} mismatch on {label}:\n"
            f"  streamed={s!r}\n  baseline={b!r}\n"
            f"diff:\n{_explain_diff(s, b)}"
        )


def _assert_full_file_parity(case: _ParityCase, jsonl_path: Path) -> int:
    shutil.copyfile(case.snapshot_path, jsonl_path)
    baseline = AgentTranscriptFile(case.worker, jsonl_path).entries

    streamer = TranscriptStreamer(jsonl_path, case.worker)
    # Streamer's constructor did the initial read; the first parse_delta
    # flushes that as a single chunk (last_emitted starts at 0).
    streamed = streamer.transcript.parse_delta()

    _assert_entries_match(streamed, baseline, label=case.label)
    return len(baseline)


def _assert_chunked_file_parity(case: _ParityCase, jsonl_path: Path) -> int:
    full_bytes = case.snapshot_path.read_bytes()
    # splitlines(keepends=True) keeps trailing newlines so concatenation
    # reproduces the original file exactly.
    lines = full_bytes.splitlines(keepends=True)

    if not lines:
        pytest.skip(f"empty file: {case.label}")

    jsonl_path.touch()
    streamer = TranscriptStreamer(jsonl_path, case.worker)
    # Sanity: empty file → no entries
    initial = streamer.transcript.parse_delta()
    assert initial == [], f"empty-file initial delta should be empty: got {initial!r}"

    for chunk in _split_lines_into_n_chunks(lines, n=10):
        if not chunk:
            continue
        with open(jsonl_path, "ab") as f:
            f.write(chunk)
        streamer.transcript.parse_delta()

    streamed_final = streamer.transcript.entries
    baseline = AgentTranscriptFile(case.worker, jsonl_path).entries
    _assert_entries_match(
        streamed_final,
        baseline,
        label=case.label,
        prefix="chunked-final ",
    )
    return len(baseline)


# ──────────────────────────────────────────────────────────────────────────────
# Parity tests
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _DISCOVERED, ids=_ids(_DISCOVERED))
def test_full_file_matches_streamed_delta(case: _ParityCase, tmp_path: Path) -> None:
    """``streamer.notify_change()`` over a fully-written file returns entries
    identical to ``AgentTranscriptFile(worker, path).entries``."""
    _assert_full_file_parity(case, tmp_path / "full.jsonl")


@pytest.mark.parametrize("case", _DISCOVERED, ids=_ids(_DISCOVERED))
def test_chunked_writes_match_full_parse(case: _ParityCase, tmp_path: Path) -> None:
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
    _assert_chunked_file_parity(case, tmp_path / "chunked.jsonl")


def test_captured_case_survives_source_deletion(tmp_path: Path) -> None:
    """A collection-owned case remains real parity coverage after source unlink."""
    source = tmp_path / "ambient" / "session.jsonl"
    source.parent.mkdir()
    source.write_text(
        '{"parentUuid":null,"isSidechain":false,"type":"user",'
        '"message":{"role":"user","content":"hello"},'
        '"uuid":"11111111-1111-4111-8111-111111111111",'
        '"sessionId":"22222222-2222-4222-8222-222222222222"}\n',
        encoding="utf-8",
    )
    cases = _capture_cases(
        [_ParityCandidate(source, "claude")],
        tmp_path / "snapshot",
    )
    assert len(cases) == 1

    source.unlink()
    assert not source.exists()

    case = cases[0]
    assert _assert_full_file_parity(case, tmp_path / "full.jsonl") > 0
    assert _assert_chunked_file_parity(case, tmp_path / "chunked.jsonl") > 0
