"""O(1) collection-change detection via monotonic version counter.

Manifest stored at <records_root>/manifests/<record_type>/.manifest.json
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl


class ManifestData(TypedDict):
    version: int
    updated_at: str
    count: int


class CollectionManifest:
    """O(1) collection-change detection via monotonic version counter.

    Manifest stored at <records_root>/manifests/<record_type>/.manifest.json
    """

    def __init__(
        self,
        record_type: str,
        records_root: Path | None = None,
    ) -> None:
        from .record import get_default_records_root
        root = records_root or get_default_records_root()
        self._dir = root / "manifests" / record_type
        self._path = self._dir / ".manifest.json"
        self._ids_path = self._dir / ".manifest-ids.json"

    def bump(self, op: str) -> None:
        """Increment version, adjust count. Atomic with file locking.

        op: "add", "update", or "remove"
        """
        self._dir.mkdir(parents=True, exist_ok=True)
        lock_path = self._dir / ".manifest.lock"
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
        try:
            if sys.platform == "win32":
                msvcrt.locking(lock_fd, msvcrt.LK_LOCK, 1)
            else:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
            data = self._read_raw()
            if data is None:
                data = {"version": 0, "updated_at": "", "count": 0}
            data["version"] += 1
            data["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            if op == "add":
                data["count"] += 1
            elif op == "remove":
                data["count"] = max(0, data["count"] - 1)
            # "update" only bumps version, not count
            # Atomic write via temp file + os.replace
            fd, tmp = tempfile.mkstemp(dir=str(self._dir), suffix=".tmp")
            try:
                os.write(fd, json.dumps(data).encode())
                os.close(fd)
                os.replace(tmp, str(self._path))
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
        finally:
            if sys.platform == "win32":
                try:
                    msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    def read(self) -> ManifestData | None:
        """Load manifest from disk. Returns None if missing."""
        return self._read_raw()

    def needs_refresh(self, last_seen_version: int) -> bool:
        """True if the on-disk version differs from last_seen_version."""
        data = self.read()
        if data is None:
            return True  # No manifest = needs rebuild
        return data["version"] != last_seen_version

    def rebuild(self, record_ids: list[str]) -> None:
        """Full rebuild -- write manifest + ids file."""
        self._dir.mkdir(parents=True, exist_ok=True)
        data: ManifestData = {
            "version": (self.read() or {}).get("version", 0) + 1,
            "updated_at": datetime.now(tz=timezone.utc).isoformat(),
            "count": len(record_ids),
        }
        self._path.write_text(json.dumps(data), encoding="utf-8")
        self._ids_path.write_text(
            json.dumps({"record_ids": record_ids}),
            encoding="utf-8",
        )

    def _read_raw(self) -> ManifestData | None:
        if not self._path.exists():
            return None
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
