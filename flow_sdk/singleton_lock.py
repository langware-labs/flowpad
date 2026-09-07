"""One process-singleton protocol, shared by the backend and its monitor.

A kernel-owned ``filelock`` (released automatically if the holder crashes) plus
a pid sidecar so a stale lock can be told from a live one. ``run.py`` uses it
to keep two backends off one instance, ``server/launch.py`` to keep two
monitors off one port. Both used to carry their own copy of this; the
protocol has one known footgun (below) and it must be fixed in one place.

Stdlib + ``filelock`` only: ``run.py`` acquires before the app is importable.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path

from filelock import FileLock, Timeout


def read_pid(pid_path: Path) -> int | None:
    """The pid recorded in a sidecar, or None if absent or unparseable."""
    try:
        return int(pid_path.read_text().strip())
    except (OSError, ValueError):
        return None


def acquire(
    lock_path: Path,
    pid_path: Path,
    holder_alive: Callable[[int], bool],
    log: logging.Logger,
    label: str,
) -> FileLock | None:
    """Take the lock and record our pid, or return None if a live holder has it.

    A lock whose recorded holder is gone (or absent) is stale: both files are
    removed and the acquire retried once. ``holder_alive`` is the caller's
    liveness test -- the backend uses a plain pid probe, the monitor also
    checks the cmdline. *label* names the singleton in log lines.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    def _try() -> FileLock | None:
        lock = FileLock(str(lock_path), timeout=0)
        try:
            lock.acquire()
        except Timeout:
            return None
        pid_path.write_text(str(os.getpid()))
        log.info("[singleton] %s lock acquired: pid=%d path=%s", label, os.getpid(), lock_path)
        return lock

    lock = _try()
    if lock is not None:
        return lock

    holder = read_pid(pid_path)
    if not holder or not holder_alive(holder):
        if holder:
            log.warning("[singleton] Stale %s lock (pid=%d is dead) — removing and retrying", label, holder)
        else:
            log.warning("[singleton] %s lock held but no pid recorded — removing and retrying", label)
        lock_path.unlink(missing_ok=True)
        pid_path.unlink(missing_ok=True)
        lock = _try()
        if lock is not None:
            return lock

    log.warning(
        "[singleton] %s already running (pid=%s) — exiting (our pid=%d)", label, holder or "unknown", os.getpid()
    )
    return None


def release(lock: FileLock | None, pid_path: Path) -> None:
    """Release the lock and drop the sidecar. Never unlinks the lock file.

    Deleting a lock file after releasing it is the classic filelock footgun:
    between release() and unlink() another process can acquire the same
    inode, we then delete the file it holds, a third creates a fresh file and
    acquires that -- and two processes are both "the singleton". A restart
    (old process exiting while the new one starts) is exactly that window.

    Leftover lock/pid files are harmless: ``acquire`` treats them as stale by
    checking the recorded pid, and ``flow instance ctl reconcile`` removes
    them, gated on no live process holding them.
    """
    if lock is not None and lock.is_locked:
        lock.release()
        pid_path.unlink(missing_ok=True)
