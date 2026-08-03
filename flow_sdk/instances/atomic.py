"""Atomic JSON reads/writes and a cross-process lock.

The write goes through ``flow_sdk.capsules.atomic.atomic_write``, which is the
tree's existing crash-safe replace: tmp file via ``mkstemp``, ``fsync`` before
rename, existing file mode preserved, and a no-op when the content is unchanged.
A local tmp+``os.replace`` would have skipped the fsync — and ``launcher.json``
and ``ports.json`` are exactly the files whose torn writes this module exists to
prevent.

``filelock`` is already a declared dependency and is what the backend's
singleton lock uses, so the lock semantics here match the rest of the tree.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def read_json(path: Path) -> dict:
    """Return the parsed object, or ``{}`` for missing/corrupt/non-object files.

    Corruption is not fatal by design: a truncated ledger must degrade to "no
    leases" so allocation still succeeds, rather than wedging every command.
    """
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json_atomic(path: Path, data: dict) -> Path:
    """Crash-safely replace ``path`` with ``data`` as indented JSON."""
    from flow_sdk.capsules.atomic import atomic_write

    atomic_write(path, json.dumps(data, indent=2).encode())
    return path


@contextmanager
def locked(lock_path: Path) -> Iterator[None]:
    """Hold a cross-process lock for a read-modify-write of a shared file.

    No timeout is passed: ``filelock``'s default is to block indefinitely, which
    is correct here. Ledger critical sections are a few filesystem operations
    long, so a wait that does not resolve means a real deadlock to fix, not a
    budget to widen.
    """
    from filelock import FileLock

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(lock_path)):
        yield
