"""TranscriptStreamer — per-session delta streamer over a single transcript JSONL.

Composes ``AgentTranscriptFile`` (which owns the parser + fold logic + offset
state) with an ``asyncio.Lock`` to serialize concurrent FSOp fire notifications.
Pure orchestration: never touches ``parser.feed``, never iterates lines, never
folds. All parsing lives on ``AgentTranscriptFile.parse_delta``.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

from flow_sdk.transcript_analyzer.entry import TranscriptEntry
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile


class TranscriptStreamer:
    """One per session. Holds the per-session ``AgentTranscriptFile`` (which
    carries the delta state) and a lock that serializes concurrent ``notify_change``
    calls. ``last_activity`` is consulted by the registry's idle sweeper.
    """

    def __init__(self, jsonl_path: Path, worker_type: str) -> None:
        # session_id is resolved by the parser from the file content (see
        # ``self.session_id`` below). The registry keys streamers by path,
        # not session_id, because for some workers (Codex) the file stem
        # is a timestamp+uuid composite — only the parser knows the true id.
        self.transcript = AgentTranscriptFile(
            worker_type=worker_type,
            path=jsonl_path,
        )
        self.last_activity: float = time.monotonic()
        self._lock = asyncio.Lock()

    @property
    def session_id(self) -> str:
        """Parser-resolved session id (from the file's first identifying line).
        May be empty until the first delta has been parsed."""
        return self.transcript.session_id

    @property
    def jsonl_path(self) -> Path:
        return self.transcript.path

    async def notify_change(self) -> list[TranscriptEntry]:
        """Read whatever the file has appended since the previous call and
        return the new entries (typed, folded). Caller (registry) fans out
        to subscribers. Concurrent callers serialize via ``_lock``.

        The parse is synchronous CPU+file I/O (can be a full-history read for
        a fresh streamer) — it runs in a worker thread so a large transcript
        never stalls the event loop. The lock is held across the thread hop,
        keeping the AgentTranscriptFile's delta state single-threaded.
        """
        async with self._lock:
            self.last_activity = time.monotonic()
            return await asyncio.to_thread(self.transcript.parse_delta)

    async def force_reparse(self) -> list[TranscriptEntry]:
        """Reset offset to 0 and re-emit the full file as one delta. Debug knob."""

        def _reparse() -> list[TranscriptEntry]:
            self.transcript.force_reparse()
            return self.transcript.parse_delta()

        async with self._lock:
            self.last_activity = time.monotonic()
            return await asyncio.to_thread(_reparse)
