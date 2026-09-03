"""Unified record reference — replaces FsRecordRef with extended fields.

A RecordRef is a lightweight pointer to another record. It can point to:
- A parent/child record (id + type + path)
- An external data source (path + json_path + format)
- An origin record for clone provenance
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path


@dataclass
class  RecordRef:
    """Flat reference to a record or external data source.

    Covers all current uses: parent/child refs, origin tracking,
    AND data pointers. Serializes to dict omitting None fields.

    The ``content_hash`` property computes a deterministic hash of the
    addressing fields (path, json_path, key_field, key_value) — useful
    as a content-addressable id for data_ref pointers.
    """

    id: str = ""
    type: str = ""
    path: str | None = None          # filesystem path (to record or data file)
    json_path: str | None = None     # RFC 6901 pointer (may include array index)
    key_field: str | None = None     # field name for identifying objects in arrays
    key_value: str | None = None     # field value to match

    @property
    def content_hash(self) -> str:
        """Deterministic hash of addressing fields. O(1).

        Stable across runs — same source produces the same hash.
        Useful for building metadata paths for referenced records.
        """
        key = f"{self.path or ''}|{self.json_path or ''}|{self.key_field or ''}|{self.key_value or ''}"
        return hashlib.md5(key.encode()).hexdigest()[:12]

    def to_dict(self) -> dict:
        """Serialize to a plain dict, omitting fields that are None or empty."""
        d: dict = {}
        if self.id:
            d["id"] = self.id
        if self.type:
            d["type"] = self.type
        if self.path is not None:
            d["path"] = self.path
        if self.json_path is not None:
            d["json_path"] = self.json_path
        if self.key_field is not None:
            d["key_field"] = self.key_field
        if self.key_value is not None:
            d["key_value"] = self.key_value
        return d

    @classmethod
    def from_dict(cls, data: dict) -> RecordRef:
        """Deserialize from a dict. Extra keys are silently ignored.

        If ``data`` contains a ``format`` key, returns a ``RecordDataRef``
        instead of a plain ``RecordRef``.
        """
        # Support legacy FsRecordRef format (record_path -> path)
        path = data.get("path") or data.get("record_path")
        if "format" in data:
            return RecordDataRef(
                id=data.get("id", ""),
                type=data.get("type", ""),
                path=path,
                json_path=data.get("json_path"),
                key_field=data.get("key_field"),
                key_value=data.get("key_value"),
                format=data.get("format"),
            )
        return cls(
            id=data.get("id", ""),
            type=data.get("type", ""),
            path=path,
            json_path=data.get("json_path"),
            key_field=data.get("key_field"),
            key_value=data.get("key_value"),
        )

    @classmethod
    def from_record(cls, record: object) -> RecordRef:
        """Build a ref from any record with id/type attrs (duck-typed).

        ``path`` is the record's ``asset_ref`` — an ``FSRef`` on ``FSRecord``
        (its ``.path`` is the string) or a plain string on a duck-typed record.
        """
        asset_ref = getattr(record, "asset_ref", None)
        path = getattr(asset_ref, "path", asset_ref)
        return cls(
            id=record.id,       # type: ignore[attr-defined]
            type=record.type,   # type: ignore[attr-defined]
            path=str(path) if path else None,
        )

    # Backward compatibility with FsRecordRef.record_path
    @property
    def record_path(self) -> str | None:
        """Alias for ``path`` — backward compat with FsRecordRef."""
        return self.path

    @record_path.setter
    def record_path(self, value: str | None) -> None:
        self.path = value


@dataclass
class RecordDataRef(RecordRef):
    """A RecordRef that can resolve to the record's data directory.

    Extends RecordRef with:
    - format: data file format hint (e.g. "json", "jsonl", "md")
    - resolve_data_dir(): returns the data/ subfolder Path for the referenced record
    - resolve_data_file(): returns the specific data file Path
    """

    format: str | None = None

    def resolve_data_dir(self, records_root: Path | None = None) -> Path | None:
        """Resolve to the data directory of the referenced record.

        Uses ``records_root`` if explicitly provided (backward-compat), otherwise
        uses ``get_default_records_data_root()`` so data blobs live under
        ``~/.flow/records_data/<type>/<id>/`` instead of alongside metadata.
        """
        if not self.type or not self.id:
            return None
        if records_root is None:
            from flow_sdk.fs_store.record_paths import data_dir_for
            return data_dir_for(self.type, self.id)
        return records_root / str(self.type) / str(self.id)

    def resolve_data_file(self, records_root: Path | None = None) -> Path | None:
        """Resolve to the specific file in the data/ subdirectory.

        Uses self.path if it is set and absolute. Otherwise falls back to
        resolve_data_dir() / "_obj_data.json".
        """
        if self.path and Path(self.path).is_absolute():
            return Path(self.path)
        data_dir = self.resolve_data_dir(records_root)
        if data_dir is None:
            return None
        return data_dir / "_obj_data.json"

    @classmethod
    def from_record(cls, record: object) -> "RecordDataRef":
        """Build a data ref from a record with id/type/source_file attrs."""
        return cls(
            id=getattr(record, "id", ""),        # type: ignore[attr-defined]
            type=getattr(record, "type", ""),    # type: ignore[attr-defined]
            path=getattr(record, "source_file", None),
        )

    @classmethod
    def from_entity_ref(cls, record_data_ref: str) -> "RecordDataRef":
        """Parse Entity.record_data_ref string ('type/id') into a RecordDataRef."""
        if "/" not in record_data_ref:
            return cls(type=record_data_ref)
        ref_type, ref_id = record_data_ref.split("/", 1)
        return cls(id=ref_id, type=ref_type)

    def to_entity_ref(self) -> str:
        """Convert to Entity.record_data_ref format: 'type/id'."""
        return f"{self.type}/{self.id}"

    def to_dict(self) -> dict:
        """Serialize, including format field."""
        d = super().to_dict()
        if self.format is not None:
            d["format"] = self.format
        return d
