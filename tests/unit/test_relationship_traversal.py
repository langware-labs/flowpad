"""Tests for RelationshipRecord.discover()."""

import json
from pathlib import Path

from flow_sdk.fs_records.relationship import RelationshipRecord, RelationshipType


class TestRelationshipDiscover:
    def test_relationship_discover(self, tmp_path: Path):
        rel_data = {
            "id": "child:agent:a1:process:p1",
            "type": RelationshipType.CHILD,
            "from_ref": {"id": "a1", "type": "agent"},
            "to_ref": {"id": "p1", "type": "process"},
        }
        (tmp_path / "rel1.json").write_text(json.dumps(rel_data), encoding="utf-8")

        results = RelationshipRecord.discover(tmp_path)
        assert len(results) == 1
        assert results[0].from_ref.id == "a1"

    def test_discover_empty_dir(self, tmp_path: Path):
        results = RelationshipRecord.discover(tmp_path)
        assert results == []

    def test_discover_nonexistent_dir(self):
        results = RelationshipRecord.discover(Path("/nonexistent"))
        assert results == []
