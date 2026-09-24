"""Boot progress — one line per step forward, none while standing still.

The two startup watchdogs (``electron/backend-wait.js`` and the monitor's
``_boot_still_progressing`` in ``server/launch.py``) keep waiting for a slow
boot only on evidence that it is still moving: growth of the booting process's
own log. The slowest phase of a boot, importing ~2,000 modules on a weak
machine, is exactly the phase in which nothing logs, so that evidence was
missing where it mattered. This module makes the boot assert its own progress:
a line whenever the module count or the declared phase changed since the last
look, and nothing when neither did. "The log grew" then means "the boot
advanced", and a silence means what the watchdogs take it to mean.

A line::

    2026-09-22T11:14:47.310Z [boot] t=12.3s phase=import modules=1312 last=sqlalchemy.orm.relationships

``last`` is the module most recently added to ``sys.modules``: on a hung
import it names the module that hung, which is what a support engineer needs
from a customer's log.

Two boot processes use it. ``flow start`` (the launcher the desktop app runs)
writes to its stdout, which the app reads as a pipe, and only when the app
asks (``FLOWPAD_BOOT_PROGRESS=1``) so a terminal user sees nothing new. The
server writes to its stderr, which IS the server log. Standard library only:
this is imported before anything else on the boot path.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from datetime import datetime, timezone
from typing import IO, Callable, Mapping

ENV_BOOT_PROGRESS = "FLOWPAD_BOOT_PROGRESS"
DEFAULT_INTERVAL_SECONDS = 1.0
FIRST_PHASE = "import"
LAST_PHASE = "done"
MARKER = "[boot]"


def _utc_stamp() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


class BootProgress:
    """The reporter for one process. ``tick`` is the whole behaviour; the thread
    only calls it on a schedule."""

    def __init__(
        self,
        stream: IO[str],
        *,
        interval: float = DEFAULT_INTERVAL_SECONDS,
        modules: Mapping[str, object] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        stamp: Callable[[], str] = _utc_stamp,
    ) -> None:
        self._stream = stream
        self._interval = interval
        self._modules = sys.modules if modules is None else modules
        self._monotonic = monotonic
        self._stamp = stamp
        self._started_at = monotonic()
        self._phase = FIRST_PHASE
        self._seen_count = -1
        self._seen_phase: str | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._stopped = False

    @property
    def phase(self) -> str:
        return self._phase

    def start(self) -> None:
        """Write the first line now, then one per change on the interval."""
        if self._thread is not None:
            return
        self.tick(force=True)
        self._thread = threading.Thread(target=self._run, name="boot-progress", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.tick()

    def set_phase(self, name: str) -> None:
        """Declare a step that is slow without importing anything (migrations,
        the database, startup hooks). Reported at once, not on the next tick."""
        if self._stopped:
            return
        self._phase = name
        self.tick()

    def stop(self) -> None:
        """The last line, ``phase=done``. Idempotent."""
        if self._stopped:
            return
        self._stopped = True
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=self._interval + 1.0)
        self._phase = LAST_PHASE
        self.tick(force=True)

    def tick(self, *, force: bool = False) -> str | None:
        """One look. Returns the line written, or None when nothing changed."""
        count = len(self._modules)
        try:
            last = next(reversed(self._modules))  # type: ignore[call-overload]
        except Exception:  # noqa: BLE001 — the dict can change under a reverse iterator
            last = "?"
        with self._lock:
            phase = self._phase
            if not force and count == self._seen_count and phase == self._seen_phase:
                return None
            self._seen_count = count
            self._seen_phase = phase
            elapsed = self._monotonic() - self._started_at
            line = f"{self._stamp()} {MARKER} t={elapsed:.1f}s phase={phase} modules={count} last={last}\n"
            try:
                self._stream.write(line)
                self._stream.flush()
            except Exception:  # noqa: BLE001 — a closed stream must never break a boot
                return None
            return line


# ---------------------------------------------------------------------------
# The per-process reporter. One per process; the phase calls below are no-ops
# until `start` ran, so a code path that runs outside a boot (tests, an
# embedded FlowServer) needs no guard.
# ---------------------------------------------------------------------------

_current: BootProgress | None = None
_current_lock = threading.Lock()


def start(stream: IO[str] | None = None, *, interval: float = DEFAULT_INTERVAL_SECONDS) -> BootProgress:
    global _current
    with _current_lock:
        if _current is None:
            _current = BootProgress(stream if stream is not None else sys.stderr, interval=interval)
            _current.start()
        return _current


def start_if_requested(stream: IO[str] | None = None) -> BootProgress | None:
    """Start only when the launcher set ``FLOWPAD_BOOT_PROGRESS``. The variable is
    consumed, not inherited: a child of this process (the monitor, the server,
    a worker's ``flow`` call) must not start printing boot lines into whatever
    reads ITS stdout."""
    if not os.environ.pop(ENV_BOOT_PROGRESS, ""):
        return None
    return start(stream)


def set_phase(name: str) -> None:
    current = _current
    if current is not None:
        current.set_phase(name)


def stop() -> None:
    global _current
    with _current_lock:
        current = _current
        _current = None
    if current is not None:
        current.stop()
