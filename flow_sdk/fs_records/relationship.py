"""Relationship record type for graph edge synchronization."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store import RecordRef, Record


class RelationshipType:
    CHILD = "child"


class RelationshipRecord(Record):
    """A first-class relationship record between two resource refs."""

    def __init__(self, **kwargs):
        # Normalize ref dicts to RecordRef before passing to super
        from_ref = kwargs.get("from_ref")
        to_ref = kwargs.get("to_ref")
        if isinstance(from_ref, dict):
            kwargs["from_ref"] = RecordRef.from_dict(from_ref)
        if isinstance(to_ref, dict):
            kwargs["to_ref"] = RecordRef.from_dict(to_ref)
        if "type" not in kwargs:
            kwargs["type"] = RelationshipType.CHILD
        super().__init__(**kwargs)

    @classmethod
    def from_dict(cls, data: dict) -> RelationshipRecord:
        """Deserialize and normalize ref fields into RecordRef."""
        rel = super().from_dict(data)
        from_ref = getattr(rel, "from_ref", None)
        to_ref = getattr(rel, "to_ref", None)
        if isinstance(from_ref, dict):
            rel.from_ref = RecordRef.from_dict(from_ref)
        if isinstance(to_ref, dict):
            rel.to_ref = RecordRef.from_dict(to_ref)
        return rel

    @staticmethod
    def make_id(rel_type: str, from_ref: RecordRef, to_ref: RecordRef) -> str:
        """Deterministic ID for the relationship edge."""
        return f"{rel_type}:{from_ref.type}:{from_ref.id}:{to_ref.type}:{to_ref.id}"

    @classmethod
    def discover(cls, records_dir: Path) -> list[RelationshipRecord]:
        """Scan a directory for relationship record JSON files.

        Relationship files use IDs with 'child:' prefix from make_id().
        """
        import json

        results: list[RelationshipRecord] = []
        if not records_dir.is_dir():
            return results
        for json_file in records_dir.glob("*.json"):
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                if data.get("type") == RelationshipType.CHILD:
                    results.append(cls.from_dict(data))
            except (json.JSONDecodeError, OSError):
                continue
        return results

    @classmethod
    def child(cls, from_ref: RecordRef, to_ref: RecordRef) -> RelationshipRecord:
        """Create a canonical parent->child edge record."""
        rel_type = RelationshipType.CHILD
        return cls(
            id=cls.make_id(rel_type, from_ref, to_ref),
            type=rel_type,
            from_ref=from_ref,
            to_ref=to_ref,
        )

    def save(self) -> None:
        """Save relationship and sync parent's children_refs."""
        super().save()
        self._sync_parent_children_refs("add")

    async def delete(self, delete_ref: bool = False) -> None:
        """Remove from parent's children_refs before deleting."""
        self._sync_parent_children_refs("remove")
        await super().delete(delete_ref=delete_ref)

    def _sync_parent_children_refs(self, op: str) -> None:
        """Update parent record's children_refs to include/exclude the to_ref.

        Loads parent from from_ref, modifies children_refs, saves parent.
        """
        from_ref = self.from_ref
        to_ref = self.to_ref
        if not isinstance(from_ref, RecordRef) or not isinstance(to_ref, RecordRef):
            return
        if not from_ref.path:
            return
        parent_path = Path(from_ref.path)
        if not parent_path.exists():
            return

        parent = Record.load_record(parent_path)

        if op == "add":
            parent.add_child(to_ref)
        elif op == "remove":
            existing = object.__getattribute__(parent, "__dict__").get("children_list", [])
            filtered = [
                c for c in existing
                if not (isinstance(c, dict) and c.get("id") == to_ref.id and c.get("type") == to_ref.type)
            ]
            object.__setattr__(parent, "children_list", filtered)
            dirty = object.__getattribute__(parent, "_dirty_keys")
            dirty.add("children")
            if parent.source_file:
                parent.save()
