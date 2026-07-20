"""Locking and atomic byte replacement shared by capsule carriers."""
from __future__ import annotations

import hashlib
import os
import stat
import tempfile
from pathlib import Path

from filelock import FileLock


def capsule_lock(path: Path) -> FileLock:
    root = Path(tempfile.gettempdir()) / "flowpad-capsule-locks"
    root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(str(path.resolve(strict=False)).encode()).hexdigest()
    return FileLock(str(root / f"{digest}.lock"))


def atomic_write(path: Path, data: bytes, *, new_mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_bytes() == data:
            return
    except OSError:
        pass
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            mode = new_mode
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
