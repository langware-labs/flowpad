"""JSONFsRef — write-through JSON file reference."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_ref.base import FSRef


class JSONFsRef(FSRef):
    """Write-through JSON file reference.

    ref_type = "json"

    Keeps _json_data: dict in memory. First access loads from disk.
    set()/update() write through to the file immediately.
    File is stored in wrapped {"data": {...}} format matching _save_split_format.
    """

    def _ref_type(self) -> str:
        return "json"

    def __init__(
        self,
        path: str | Path,
        read_only: bool = False,
        parent: "FSRef | None" = None,
        type_id: str = "compute_node-@local",
    ) -> None:
        super().__init__(path, read_only=read_only, parent=parent, type_id=type_id)
        self._json_data: dict | None = None

    def _ensure_loaded(self) -> None:
        if self._json_data is None:
            import json

            if Path(self.path).exists():
                raw = json.loads(Path(self.path).read_text(encoding="utf-8"))
                self._json_data = raw.get("data", raw) if isinstance(raw, dict) else {}
            else:
                self._json_data = {}

    def _flush(self) -> None:
        if self.read_only:
            raise IOError(f"JSONFsRef at {self.path!r} is read-only")
        import json

        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.path).write_text(
            json.dumps({"data": self._json_data}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def get(self, key: str, default=None):
        self._ensure_loaded()
        return self._json_data.get(key, default)

    def set(self, key: str, value) -> None:
        self._ensure_loaded()
        self._json_data[key] = value
        self._flush()

    def update(self, data: dict) -> None:
        self._ensure_loaded()
        self._json_data.update(data)
        self._flush()

    def load(self) -> dict:
        self._json_data = None
        self._ensure_loaded()
        return dict(self._json_data)

    def as_dict(self) -> dict:
        self._ensure_loaded()
        return dict(self._json_data)

    def write(self, content: str) -> None:
        """Write raw text content (resets JSON cache)."""
        if self.read_only:
            raise IOError(f"JSONFsRef at {self.path!r} is read-only")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(content, encoding="utf-8")
        self._json_data = None  # invalidate cache

    @property
    def hash(self) -> str:
        """SHA256 of the file content."""
        import hashlib

        try:
            return hashlib.sha256(self._path.read_bytes()).hexdigest()
        except OSError:
            return ""
