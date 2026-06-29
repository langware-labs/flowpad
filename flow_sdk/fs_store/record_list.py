"""RecordList — thin storage-agnostic typed record collection over FSRecord.

Successor to the Record-class-based RecordList. Uses ``FSRecord`` directly
for discover / load / persist. Callers pass a ``type_name`` string.
Discovery is always live (no caching layer).
"""

from __future__ import annotations

import shutil
from typing import Any, Iterator

from .fs_record import FSRecord


class RecordList:
    """Typed record collection backed by ``FSRecord``."""

    def __init__(self, *, type_name: str, scope: Any = None) -> None:
        self.type_name = str(type_name)
        self.scope = scope

    # ── Read ──────────────────────────────────────────────────────────────

    def _discover(self) -> list[FSRecord]:
        return FSRecord.discover(self.type_name)

    def __iter__(self) -> Iterator[FSRecord]:
        return iter(self._discover())

    def __len__(self) -> int:
        # Count-only: no metadata.json reads/parses.
        return FSRecord.count(self.type_name)

    def get(self, uid: str) -> FSRecord | None:
        return FSRecord.load_or_none(self.type_name, uid)

    # ── Write ─────────────────────────────────────────────────────────────

    def create(self, data: FSRecord | dict) -> FSRecord:
        if isinstance(data, dict):
            payload = dict(data)
            payload.setdefault("type", self.type_name)
            record = FSRecord.from_dict(payload)
        else:
            record = data
        existing = self.get(record.id) if record.id else None
        if existing is not None:
            raise ValueError(f"Record with id {record.id!r} already exists")
        record.save()
        return record

    def save(self, record: FSRecord) -> None:
        record.save()

    def update(self, record_id: str, data: dict[str, Any]) -> FSRecord:
        record = self.get(record_id)
        if record is None:
            raise KeyError(f"No record with id {record_id!r}")
        patch = {k: v for k, v in data.items() if k not in ("type", "id")}
        record.save_metadata(patch)
        return record

    async def delete(self, record_id: str) -> bool:
        record = self.get(record_id)
        if record is None:
            return False
        try:
            shutil.rmtree(record.shadow_dir)
        except (FileNotFoundError, OSError):
            pass
        return True

    # ── Query ─────────────────────────────────────────────────────────────

    def query(self, q) -> list[FSRecord]:
        """Apply a RecordQuery in-memory over discovered records."""
        records = self._discover()
        if q is None:
            return records
        if hasattr(q, "apply"):
            return list(q.apply(records))
        return records
