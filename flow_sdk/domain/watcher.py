"""Watch mechanism for AgenticProcess events.

Two backends:
- FILE (watchfiles): tails Claude transcript JSONL in ~/.claude/projects/
- WEBSOCKET: connects to ws://localhost:9007/ws/hooks, receives hook events

Usage::

    watcher = watch(WatchType.FILE, lambda e: e.get("type") == "user", callback)
    process.start(watcher=watcher)
    process.prompt("...")
    await watcher.wait_for_event(timeout=30)
    watcher.stop()
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from abc import ABC, abstractmethod
from enum import StrEnum
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)


class WatchType(StrEnum):
    FILE = "file"
    WEBSOCKET = "ws"


class Watcher(ABC):
    """Base watcher: attach to a process workdir, poll for matching events."""

    def __init__(
        self,
        filter_fn: Callable[[dict], bool],
        callback: Callable[[dict], None],
    ) -> None:
        self._filter = filter_fn
        self._callback = callback
        self._event = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._workdir: Path | None = None

    def attach(self, workdir: Path) -> None:
        """Called by AgenticProcess.start() to set the workdir context."""
        self._workdir = workdir

    def start(self) -> None:
        """Start the background loop (must be called from within an async context)."""
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._run_loop())

    def stop(self) -> None:
        """Cancel the background loop."""
        if self._task and not self._task.done():
            self._task.cancel()

    async def wait_for_event(self, timeout: float = 30.0) -> None:
        """Block until at least one matching event fires, or timeout."""
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(f"No matching event received within {timeout}s")

    def _dispatch(self, entry: dict) -> None:
        """Apply filter; if it matches fire callback and set the event flag."""
        try:
            matches = self._filter(entry)
        except Exception:
            return
        if matches:
            self._callback(entry)
            self._event.set()

    async def _run_loop(self) -> None:
        """Wrapper that logs exceptions from the background loop."""
        try:
            await self._loop()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("%s loop failed: %s", self.__class__.__name__, exc, exc_info=True)

    @abstractmethod
    async def _loop(self) -> None: ...


class FileWatcher(Watcher):
    """Watch Claude transcript JSONL files for new entries via watchfiles.awatch().

    Watches ~/.claude/projects/<encoded-workdir>/ for new or modified .jsonl
    files, then reads and dispatches each new line as a parsed dict.
    """

    def __init__(
        self,
        filter_fn: Callable[[dict], bool],
        callback: Callable[[dict], None],
    ) -> None:
        super().__init__(filter_fn, callback)
        self._file_offsets: dict[str, int] = {}

    async def _loop(self) -> None:
        from watchfiles import awatch

        # Claude Code encodes the CWD by replacing every non-alphanumeric char
        # with '-'. macOS also resolves /var → /private/var before encoding.
        encoded = re.sub(r"[^a-zA-Z0-9]", "-", self._workdir.resolve().as_posix())
        watch_dir = Path.home() / ".claude" / "projects" / encoded
        watch_dir.mkdir(parents=True, exist_ok=True)
        logger.debug("FileWatcher watching %s", watch_dir)

        async for changes in awatch(str(watch_dir), debounce=200):
            for _change, file_path in changes:
                if file_path.endswith(".jsonl"):
                    self._read_new_lines(Path(file_path))

    def _read_new_lines(self, path: Path) -> None:
        if not path.exists():
            return
        offset = self._file_offsets.get(str(path), 0)
        try:
            with open(path, "rb") as fh:
                fh.seek(offset)
                new_bytes = fh.read()
                self._file_offsets[str(path)] = offset + len(new_bytes)
        except OSError:
            return
        for raw_line in new_bytes.decode("utf-8", errors="replace").splitlines():
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            self._dispatch(entry)


class WebSocketWatcher(Watcher):
    """Watch transcript entries via the server's /api/watch/transcript WebSocket.

    The server watches the same Claude project directory as FileWatcher and
    pushes each new JSONL line as ``{"type": "transcript_entry", "entry": {...}}``.
    Filter and callback receive the same entry dicts as FileWatcher.

    Requires a running server at ``server_url`` (default http://localhost:9007).
    """

    def __init__(
        self,
        filter_fn: Callable[[dict], bool],
        callback: Callable[[dict], None],
        server_url: str = "http://localhost:9007",
    ) -> None:
        super().__init__(filter_fn, callback)
        self._server_url = server_url.rstrip("/")

    async def _loop(self) -> None:
        import websockets

        encoded = re.sub(r"[^a-zA-Z0-9]", "-", self._workdir.resolve().as_posix())
        ws_url = (
            self._server_url
            .replace("http://", "ws://")
            .replace("https://", "wss://")
        )
        ws_url = f"{ws_url}/api/watch/transcript?project_dir={encoded}"
        logger.debug("WebSocketWatcher connecting to %s", ws_url)

        async with websockets.connect(ws_url) as ws:
            async for raw_msg in ws:
                try:
                    data = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "transcript_entry":
                    self._dispatch(data.get("entry", {}))


def watch(
    watch_type: WatchType | str,
    filter_fn: Callable[[dict], bool],
    callback: Callable[[dict], None],
    **kwargs,
) -> Watcher:
    """Create a Watcher for the given watch type.

    Args:
        watch_type: WatchType.FILE or WatchType.WEBSOCKET
        filter_fn: predicate applied to each event dict; fires callback on True
        callback: called with the event dict when filter_fn matches
        **kwargs: server_url for WEBSOCKET (default "http://localhost:9007")

    Returns:
        Watcher (not yet started; attach() + start() called by AgenticProcess.start())
    """
    wt = WatchType(watch_type)
    if wt == WatchType.FILE:
        return FileWatcher(filter_fn, callback)
    if wt == WatchType.WEBSOCKET:
        return WebSocketWatcher(filter_fn, callback, **kwargs)
    raise ValueError(f"Unknown watch type: {watch_type}")
