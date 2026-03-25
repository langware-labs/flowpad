"""RecordState — manages state.json for a Record.

Tracks discovery state and stores PropertyRecord cached values as plain dicts.

state.json format:
{
  "fields": { "<key>": { "type": "...", "ttl": N, "computed_at": "...", "value": ... } },
  "meta": { "id": "...", "type": "...", "name": "..." }  // optional
}
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .record import Record

_STATE_JSON = "state.json"


class RecordState:
    """Manages state.json for a Record — discovery timestamp + property entry cache.

    Property entries are stored as plain dicts keyed by property name under the
    ``fields`` key.
    The descriptor objects (PropertyRecord instances on the parent class) own the
    serialization / deserialization / TTL logic; RecordState is just the store.
    """

    def __init__(self, record: "Record"):
        self._record = record
        self._discovered_at: datetime | None = None
        self._fields: dict[str, dict] = {}
        self._dirty: bool = False

    # ── Discovery state ────────────────────────────────────────────────────

    def is_discovered(self) -> bool:
        """True if state.json was loaded and contains a discovered_at timestamp."""
        return self._discovered_at is not None

    def mark_discovered(self) -> None:
        self._discovered_at = datetime.now(timezone.utc)
        self._dirty = True

    # ── Property management ────────────────────────────────────────────────

    def get_property(self, key: str) -> dict | None:
        """Return the cached entry dict for *key*, or None if not yet computed."""
        return self._fields.get(key)

    def set_property(self, key: str, entry: dict) -> None:
        """Store a computed entry dict for *key*."""
        self._fields[key] = entry
        self._dirty = True

    # ── Persistence ────────────────────────────────────────────────────────

    def load(self) -> None:
        """Read state.json from disk. Silent no-op if absent or no folder path."""
        path = self._state_path()
        if path is None or not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return

        if "fields" not in raw:
            return
        self._discovered_at = datetime.now(timezone.utc)
        for key, entry in raw["fields"].items():
            if isinstance(entry, dict):
                self._fields[key] = entry

    def save(self, meta: dict | None = None) -> None:
        """Write state.json to disk. Silent no-op if record has no writable path.

        Args:
            meta: Optional metadata dict (id, type, name) to store in the
                  ``meta`` key of state.json for quick lookups without reading
                  the full record data.
        """
        path = self._state_path()
        if path is None:
            return
        data: dict = {
            "fields": dict(self._fields),
        }
        if meta is not None:
            data["meta"] = meta
        try:
            from flow_sdk.fs_store.fs_ref import JSONFsRef
            JSONFsRef(path).write(json.dumps(data, indent=2))
            self._dirty = False
        except OSError:
            pass  # silently skip if path is not writable (e.g. read-only records)

    def _state_path(self) -> Path | None:
        """Path to state.json for this record.

        Priority:
        1. If ``_record_folder_ref`` is *explicitly* set on the record (not
           auto-resolved from default_path), use that shadow folder — this
           prevents external-backed records (skills, ~/.claude/projects/) from
           writing state.json into their source directories.
        2. Fall back to ``record_dir`` (derived from ``path`` or ``source_file``)
           so that records pointed at arbitrary directories work correctly.
        3. For FILE-layout records backed by a ``.jsonl`` source, place the
           state alongside the JSONL file as ``<stem>.state.json``.
        """
        # Read-only records never write state files
        if self._record._is_read_only():
            return None

        # FILE layout records backed by a .jsonl source
        sf = self._record.source_file
        if sf:
            p = Path(sf)
            if p.suffix == ".jsonl":
                return p.parent / (p.stem + ".state.json")

        try:
            return Path(self._record.metadata_ref.path) / _STATE_JSON
        except ValueError:
            return None
