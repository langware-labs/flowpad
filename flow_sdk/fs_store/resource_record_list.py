"""A typed collection of Records backed by folders on disk.

Every operation goes directly to disk — no in-memory list, no bulk load.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Iterator

from .record import Record, _DATA_JSON, record_stem


@dataclass
class ResourceRecordList:
    """Typed collection of records persisted to disk as FOLDER-layout records.

    Each record is stored as a directory ``<type>-@<uid>/`` inside ``list_path/``
    containing a ``data.json`` (and optionally a ``metadata.json`` + ``data/``
    subfolder for domain files).

    All operations read/write individual files directly — there is no
    bulk ``load()`` or in-memory cache.

    When ``list_path`` is omitted the collection path is computed as
    ``records_path / <record_type>``, where *records_path* defaults to
    ``~/.flow/records`` (the ``RECORDS_PATH`` constant from ``utils.conf``).
    The record type is inferred from ``record_class``.
    """

    list_path: Path | None = None
    record_class: type[Record] = field(default=Record)
    records_path: Path | None = None

    def __post_init__(self):
        self._record_type = self.record_class().type
        if self.list_path is None:
            if not self._record_type:
                raise ValueError(
                    "list_path is required when record_class has no default type"
                )
            base = self.records_path
            if base is None:
                from .record import get_default_records_root
                base = get_default_records_root()
            self.list_path = base / self._record_type

    # -- Path helpers --

    def _record_file(self, record_id: str, record_type: str | None = None) -> Path:
        """Return the on-disk path for a record with the given id."""
        rtype = record_type or self._record_type
        stem = record_stem(rtype, record_id)
        return self.list_path / stem / _DATA_JSON

    # -- CRUD --

    def get(self, record_id: str) -> Record | None:
        """Read a single record from disk by id."""
        fp = self._record_file(record_id)
        if not fp.exists():
            return None
        try:
            rec = self.record_class.init_record(fp)
        except (json.JSONDecodeError, ValueError, OSError):
            # File exists but is empty/corrupt (concurrent write race) or
            # unreadable — treat as missing.
            return None
        stem = record_stem(rec.type or self._record_type, record_id)
        rec.path = str(self.list_path / stem)
        return rec

    def create(self, record: Record | dict) -> Record:
        """Persist a new record to disk. Raises if id already exists."""
        if isinstance(record, dict):
            record = self.record_class.from_dict(record)
        fp = self._record_file(record.id, record.type)
        if fp.exists():
            raise ValueError(f"Record with id {record.id!r} already exists")
        self._write(record, fp)
        return record

    def save(self, record: Record) -> None:
        """Persist a record to disk (create or overwrite)."""
        fp = self._record_file(record.id, record.type)
        self._write(record, fp)

    def update(self, record_id: str, data: dict[str, Any]) -> Record:
        """Read a record, apply field updates, and persist. Raises if missing."""
        from .record import Record

        record = self.get(record_id)
        if record is None:
            raise KeyError(f"No record with id {record_id!r}")

        if isinstance(record, Record):
            # Record uses __setattr__ routing — all fields go through it
            for key, value in data.items():
                setattr(record, key, value)
        else:
            # Legacy dataclass path
            known_fields = {f.name for f in fields(record)}
            for key, value in data.items():
                if key in known_fields:
                    setattr(record, key, value)
                else:
                    record.raw_json[key] = value
        self.save(record)
        return record

    def delete(self, record_id: str) -> bool:
        """Remove a record from disk. Returns True if it existed."""
        rtype = self._record_type
        stem = record_stem(rtype, record_id)
        stem_dir = self.list_path / stem
        if stem_dir.is_dir():
            shutil.rmtree(stem_dir, ignore_errors=True)
            return True
        return False

    # -- Collection access (lazy iteration from disk) --

    def __iter__(self) -> Iterator[Record]:
        """Iterate all records, reading each from disk one at a time."""
        if not self.list_path or not self.list_path.is_dir():
            return
        for entry in sorted(self.list_path.iterdir()):
            if not entry.is_dir() or "-@" not in entry.name:
                continue
            dj = entry / _DATA_JSON
            if not dj.exists():
                continue
            try:
                rec = self.record_class.init_record(dj)
                rec.path = str(entry)
                yield rec
            except (json.JSONDecodeError, ValueError, OSError):
                continue

    def __len__(self) -> int:
        """Count records on disk without loading them."""
        if not self.list_path or not self.list_path.is_dir():
            return 0
        return sum(
            1 for e in self.list_path.iterdir()
            if e.is_dir() and "-@" in e.name and (e / _DATA_JSON).exists()
        )

    @property
    def records(self) -> list[Record]:
        """Return all records as a list (reads every file from disk)."""
        return list(self)

    # -- Internal --

    def _write(self, record: Record, fp: Path) -> None:
        """Write a single record to its file path (flat JSON, no folder redirect)."""
        import json as _json
        fp.parent.mkdir(parents=True, exist_ok=True)
        record.path = str(fp.parent)
        wrapped = {"data": record.meta_dict()}
        fp.write_text(_json.dumps(wrapped, indent=2, ensure_ascii=False), encoding="utf-8")
        object.__setattr__(record, "_source_file", str(fp))
