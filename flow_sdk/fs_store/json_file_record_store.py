"""Bidirectional adapter between a single JSON file and a set of Record objects.

Unlike ``ResourceRecordList`` (one file per record on disk), this parses
a single JSON file and produces multiple typed records, each tagged with a
``json_path`` (RFC 6901 JSON Pointer) indicating its position within the
source file.

Subclasses override ``_extract(data)`` to define extraction rules.
For writable source files, subclasses also override ``_build_json(records)``
to reconstruct the source file from modified records.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, fields as dc_fields, field
from pathlib import Path
from typing import Any, Iterator

from .record import Record, _SKIP_SERIALIZE


def _escape_json_pointer(segment: str) -> str:
    """Escape a JSON Pointer segment per RFC 6901: ``~`` -> ``~0``, ``/`` -> ``~1``."""
    return segment.replace("~", "~0").replace("/", "~1")


def _unescape_json_pointer(segment: str) -> str:
    """Unescape a JSON Pointer segment per RFC 6901: ``~1`` -> ``/``, ``~0`` -> ``~``."""
    return segment.replace("~1", "/").replace("~0", "~")


def _resolve_pointer(data: dict, pointer: str) -> Any:
    """Resolve an RFC 6901 JSON Pointer against *data*. Returns the value."""
    if not pointer or pointer == "/":
        return data
    parts = pointer.strip("/").split("/")
    current = data
    for part in parts:
        key = _unescape_json_pointer(part)
        if isinstance(current, dict):
            current = current[key]
        else:
            raise KeyError(f"Cannot resolve pointer {pointer!r} -- hit non-dict at {key!r}")
    return current


def _set_pointer(data: dict, pointer: str, value: Any) -> None:
    """Set a value at an RFC 6901 JSON Pointer within *data*.

    Creates intermediate dicts as needed.
    """
    if not pointer or pointer == "/":
        # Can't replace root via pointer -- caller should handle this
        raise ValueError("Cannot set root pointer; replace data directly")
    parts = pointer.strip("/").split("/")
    current = data
    for part in parts[:-1]:
        key = _unescape_json_pointer(part)
        if key not in current or not isinstance(current[key], dict):
            current[key] = {}
        current = current[key]
    current[_unescape_json_pointer(parts[-1])] = value


def _delete_pointer(data: dict, pointer: str) -> bool:
    """Delete the value at an RFC 6901 JSON Pointer. Returns True if deleted."""
    if not pointer or pointer == "/":
        return False
    parts = pointer.strip("/").split("/")
    current = data
    for part in parts[:-1]:
        key = _unescape_json_pointer(part)
        if not isinstance(current, dict) or key not in current:
            return False
        current = current[key]
    key = _unescape_json_pointer(parts[-1])
    if isinstance(current, dict) and key in current:
        del current[key]
        return True
    return False


@dataclass
class JsonFileRecordStore:
    """A list of Records extracted from a single JSON source file.

    Subclasses override ``_extract(data)`` to define how typed records
    are created from the parsed JSON.

    For writable source files, subclasses also override
    ``_record_to_json(record)`` to convert a record back to the JSON
    fragment that belongs at its ``json_path``.
    """

    source_file: Path | str = ""
    root_type: str = ""

    _cache: list[Record] | None = field(default=None, repr=False, init=False)

    def _load_data(self) -> dict:
        """Read and parse the source file."""
        p = Path(self.source_file)
        if not p.exists():
            return {}
        return json.loads(p.read_text(encoding="utf-8"))

    def _save_data(self, data: dict) -> None:
        """Write the full JSON back to the source file."""
        p = Path(self.source_file)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def _extract(self, data: dict) -> list[Record]:
        """Override: extract typed records from parsed JSON.

        Each record should have ``json_path``, ``source_file``, and
        ``parent_ref`` set appropriately.
        """
        raise NotImplementedError

    def _record_to_json(self, record: Record) -> dict:
        """Override: convert a record back to the JSON fragment for its json_path.

        The default implementation converts known dataclass fields (excluding
        Record internal fields) back to camelCase keys.
        For non-dataclass Record subclasses, it iterates over _data keys.
        Subclasses should override for precise control.
        """
        return _default_record_to_json(record)

    def _ensure_cache(self) -> list[Record]:
        if self._cache is None:
            data = self._load_data()
            self._cache = self._extract(data) if data else []
        return self._cache

    def reload(self) -> None:
        """Invalidate the cache and re-read from disk."""
        self._cache = None

    def __iter__(self) -> Iterator[Record]:
        return iter(self._ensure_cache())

    def __len__(self) -> int:
        return len(self._ensure_cache())

    @property
    def records(self) -> list[Record]:
        """Return all extracted records as a list."""
        return list(self._ensure_cache())

    def get(self, record_type: str, record_id: str) -> Record | None:
        """Find a record by type and id."""
        for r in self._ensure_cache():
            if r.type == record_type and r.id == record_id:
                return r
        return None

    def by_type(self, record_type: str) -> list[Record]:
        """Filter records by type."""
        return [r for r in self._ensure_cache() if r.type == record_type]

    # -- Write-back CRUD -------------------------------------------------------

    def update(self, record_type: str, uid: str, data: dict[str, Any]) -> Record:
        """Update a record's fields and write back to the source file.

        Finds the record by type+uid, applies field updates, converts the
        record back to JSON, patches the source file at the record's
        ``json_path``, and writes the file.

        Raises ``KeyError`` if the record is not found.
        """
        record = self.get(record_type, uid)
        if record is None:
            raise KeyError(f"No record with type={record_type!r} uid={uid!r}")
        if record._is_read_only():
            from .exceptions import ReadOnlyRecordError
            raise ReadOnlyRecordError(
                f"{record.__class__.__name__} is read-only and cannot be updated"
            )

        # Apply field updates
        if dataclasses.is_dataclass(record):
            known_fields = {f.name for f in dc_fields(record)}
            for key, value in data.items():
                if key in known_fields:
                    setattr(record, key, value)
                else:
                    record.raw_json[key] = value
        else:
            # Record-based (non-dataclass): all domain fields go via __setattr__
            for key, value in data.items():
                setattr(record, key, value)

        # Write back to source file
        self._write_record_to_source(record)
        return record

    def delete_record(self, record_type: str, uid: str) -> bool:
        """Remove a record's JSON fragment from the source file.

        Only works for non-root records (those with a non-empty ``json_path``).
        Returns True if deleted, False if not found.
        """
        record = self.get(record_type, uid)
        if record is None:
            return False
        if record._is_read_only():
            from .exceptions import ReadOnlyRecordError
            raise ReadOnlyRecordError(
                f"{record.__class__.__name__} is read-only and cannot be deleted"
            )
        if not record.json_path or record.json_path == "/":
            raise ValueError("Cannot delete the root record of a source file")

        file_data = self._load_data()
        deleted = _delete_pointer(file_data, record.json_path)
        if deleted:
            self._save_data(file_data)
            self.reload()
        return deleted

    def _write_record_to_source(self, record: Record) -> None:
        """Serialize one record and patch it into the source file."""
        fragment = self._record_to_json(record)
        file_data = self._load_data() or {}

        if not record.json_path or record.json_path == "/":
            # Root record -- replace the entire file content, preserving
            # keys that belong to sub-records (they manage themselves).
            file_data.update(fragment)
        else:
            _set_pointer(file_data, record.json_path, fragment)

        self._save_data(file_data)
        self.reload()


# -- Internal helpers ----------------------------------------------------------


def _snake_to_camel(name: str) -> str:
    """Convert ``snake_case`` to ``camelCase``."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _default_record_to_json(record: Record) -> dict:
    """Generic fallback: convert a record's domain fields to camelCase JSON.

    Works with both dataclass-based and non-dataclass Record subclasses.
    """
    result: dict[str, Any] = {}
    if dataclasses.is_dataclass(record):
        for f in dc_fields(record):
            if f.name in _SKIP_SERIALIZE:
                continue
            value = getattr(record, f.name)
            camel_key = _snake_to_camel(f.name)
            result[camel_key] = value
    else:
        # Record-based (non-dataclass): read live values via meta_dict()
        data = record.meta_dict()
        for key, value in data.items():
            if key in _SKIP_SERIALIZE:
                continue
            camel_key = _snake_to_camel(key)
            result[camel_key] = value
    return result
