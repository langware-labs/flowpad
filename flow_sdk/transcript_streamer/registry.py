"""TranscriptStreamerRegistry — singleton mapping session_id → TranscriptStreamer
+ global subscriber dispatch + eviction.

Entry point for the FSOp route callback: ``notify_change(jsonl_path)`` resolves
or creates the per-session streamer, parses the delta, and fans out to all
registered subscribers. Subscriber failures are isolated.

Eviction is two-tier:
  - PTY-tied sessions → ``remove(session_id)`` called from
    ``AgenticProcess.stop_pty`` / ``_on_terminal_close``.
  - All other sessions → background idle sweeper drops streamers whose
    ``last_activity`` is older than ``IDLE_TTL_SECONDS``.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from flow_sdk.flowpad_types.vendors import vendor_for_path
from flow_sdk.transcript_analyzer.entry import TranscriptEntry
from flow_sdk.transcript_streamer.cursors import TranscriptCursorStore
from flow_sdk.transcript_streamer.streamer import TranscriptStreamer

_log = logging.getLogger(__name__)

# How long a session can be idle (no notify_change call) before the idle sweeper
# drops its streamer. Per the locked design decision in the plan.
IDLE_TTL_SECONDS: float = 3600.0
# Sweeper interval — how often it checks for idle streamers.
SWEEPER_INTERVAL_SECONDS: float = 60.0


SubscriberCb = Callable[[str, Path, list[TranscriptEntry]], Awaitable[None]]


def _infer_worker_type(path: Path) -> str:
    """Infer worker_type from the transcript file's path. Matches the canonical
    on-disk layout: Claude under ``~/.claude/projects/...``, Codex under
    ``~/.codex/sessions/...``, Copilot under ``~/.copilot/session-state/...``.

    Returns the key understood by :func:`flow_sdk.transcript_analyzer.parsers.get_parser_class`:
    ``"claude"``, ``"codex"``, or ``"copilot"``.
    """
    vendor = vendor_for_path(path)
    if vendor is None:
        raise ValueError(f"Cannot infer worker_type from path: {path}")
    return vendor.key


class TranscriptStreamerRegistry:
    """Process-wide singleton. Owns per-session streamers + the global
    subscriber list + the idle-sweeper task.
    """

    def __init__(self) -> None:
        # Primary index: path → streamer. Path is unique per file/session and
        # known at FSOp dispatch time. Codex stems are not session_ids, so
        # path is the only reliable key.
        self._by_path: dict[Path, TranscriptStreamer] = {}
        self._subscribers: dict[str, SubscriberCb] = {}
        self._idle_sweeper: asyncio.Task[Any] | None = None
        # Persisted consumption state (path → size/mtime at last full consume).
        # Optional — attached by the server via configure_cursors(); bare
        # registries (tests, ad-hoc tooling) run without persistence.
        self._cursors: TranscriptCursorStore | None = None

    # ── persisted cursors ────────────────────────────────────────────────────

    def configure_cursors(self, path: Path) -> None:
        """Attach the persisted cursor store. Loads synchronously — call via
        ``asyncio.to_thread`` from async code."""
        self._cursors = TranscriptCursorStore(path)

    def needs_catch_up(self, jsonl_path: Path) -> bool:
        """True when the file may hold content not yet consumed (per the
        persisted cursors). Pure sync (one ``stat``) — bulk callers run it
        off-loop. Without a cursor store everything needs catch-up."""
        if self._cursors is None:
            return True
        try:
            st = Path(jsonl_path).stat()
        except OSError:
            return False
        return not self._cursors.is_consumed(
            Path(jsonl_path), size=st.st_size, mtime_ns=st.st_mtime_ns
        )

    async def flush_cursors(self) -> None:
        """Persist dirty cursor state. No-op without a store."""
        if self._cursors is not None:
            await asyncio.to_thread(self._cursors.flush)

    # ── subscribers ──────────────────────────────────────────────────────────

    def subscribe(self, name: str, cb: SubscriberCb) -> Callable[[], None]:
        """Register a callback. Returns an unsubscribe function."""
        self._subscribers[name] = cb

        def _unsub() -> None:
            self._subscribers.pop(name, None)

        return _unsub

    # ── lifecycle of a session's streamer ────────────────────────────────────

    def get_streamer(self, session_id: str) -> TranscriptStreamer | None:
        """Look up by parser-resolved session_id. Linear scan (small set)."""
        for s in self._by_path.values():
            if s.session_id == session_id:
                return s
        return None

    def get_streamer_by_path(self, jsonl_path: Path) -> TranscriptStreamer | None:
        return self._by_path.get(Path(jsonl_path))

    def remove(self, session_id: str) -> None:
        """Drop streamer(s) whose parser-resolved session_id matches. Called
        from PTY-close hooks on ``AgenticProcess``."""
        for path in [p for p, s in self._by_path.items() if s.session_id == session_id]:
            self._by_path.pop(path, None)

    def remove_by_path(self, jsonl_path: Path) -> None:
        self._by_path.pop(Path(jsonl_path), None)

    # ── FSOp entry point ─────────────────────────────────────────────────────

    async def notify_change(self, jsonl_path: Path) -> None:
        """Called by the FSOp route callback whenever a watched transcript
        JSONL file changes. Resolves or creates the streamer, parses the
        delta, dispatches to subscribers.
        """
        path = Path(jsonl_path)
        try:
            worker_type = _infer_worker_type(path)
        except ValueError:
            _log.warning("transcript_streamer: unknown worker for path %s", path)
            return

        # Stat BEFORE parsing: if the file grows mid-parse, the cursor records
        # the older state and the next notification re-parses the tail —
        # over-delivery is safe (idempotent subscribers), under-delivery isn't.
        try:
            pre_stat = path.stat()
        except OSError:
            pre_stat = None

        streamer = self._by_path.get(path)
        if streamer is None:
            try:
                # Construction eagerly parses the whole file
                # (AgentTranscriptFile.__init__) — keep that CPU work off-loop.
                streamer = await asyncio.to_thread(TranscriptStreamer, path, worker_type)
            except Exception:
                _log.exception("transcript_streamer: failed to construct streamer for %s", path)
                return
            # Another notification may have raced the construction; keep the
            # registered instance so delta state stays single-homed.
            streamer = self._by_path.setdefault(path, streamer)

        try:
            new_entries = await streamer.notify_change()
        except Exception:
            _log.exception("transcript_streamer: notify_change failed for %s", path)
            return

        if self._cursors is not None and pre_stat is not None:
            self._cursors.update(path, size=pre_stat.st_size, mtime_ns=pre_stat.st_mtime_ns)

        if not new_entries:
            return

        # Use the parser-resolved session_id (may differ from path.stem for
        # Codex). Fall back to the path stem if the parser hasn't resolved
        # one yet — better a routable id than empty.
        session_id = streamer.session_id or path.stem
        await self._dispatch(session_id, path, new_entries)

    async def _dispatch(
        self,
        session_id: str,
        jsonl_path: Path,
        entries: list[TranscriptEntry],
    ) -> None:
        """Fan out to subscribers. One subscriber raising does not skip others."""
        for name, cb in list(self._subscribers.items()):
            try:
                await cb(session_id, jsonl_path, entries)
            except Exception:
                _log.exception(
                    "transcript_streamer: subscriber %r raised on session %s",
                    name, session_id,
                )

    async def force_reparse(self, session_id: str) -> None:
        """Reset the session's streamer offset and re-emit history. Debug knob."""
        streamer = self.get_streamer(session_id)
        if streamer is None:
            return
        new_entries = await streamer.force_reparse()
        if new_entries:
            await self._dispatch(session_id, streamer.transcript.path, new_entries)

    # ── eviction (idle sweeper) ──────────────────────────────────────────────

    async def start_idle_sweeper(self) -> None:
        """Spawn the background task that evicts streamers idle > IDLE_TTL_SECONDS.
        Idempotent — second call is a no-op while the task is alive.
        """
        if self._idle_sweeper is not None and not self._idle_sweeper.done():
            return
        self._idle_sweeper = asyncio.create_task(self._idle_sweep_loop(), name="transcript-streamer-idle-sweep")

    async def stop_idle_sweeper(self) -> None:
        """Cancel + await the sweeper task. Safe to call when no sweeper is running."""
        task = self._idle_sweeper
        self._idle_sweeper = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def _idle_sweep_loop(self) -> None:
        """Per-interval check: drop streamers whose last_activity is older than the TTL."""
        try:
            while True:
                await asyncio.sleep(SWEEPER_INTERVAL_SECONDS)
                self._evict_idle()
                await self.flush_cursors()
        except asyncio.CancelledError:
            raise

    def _evict_idle(self, *, ttl: float | None = None) -> int:
        """Drop streamers whose last_activity is older than ttl seconds.
        Returns the number evicted (useful for tests). Exposed for tests
        to drive directly with a short TTL.
        """
        cutoff = time.monotonic() - (ttl if ttl is not None else IDLE_TTL_SECONDS)
        stale = [p for p, s in self._by_path.items() if s.last_activity < cutoff]
        for p in stale:
            self._by_path.pop(p, None)
        return len(stale)

    # ── len / debug ──────────────────────────────────────────────────────────

    def __len__(self) -> int:
        return len(self._by_path)


transcript_streamer_registry = TranscriptStreamerRegistry()
