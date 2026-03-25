"""Tests for SessionAnalysis record type."""

import json
from pathlib import Path

import pytest

from flow_sdk.fs_records.session_analysis import SessionAnalysis
from flow_sdk.fs_store import Record
from flow_sdk.fs_store.factory.type_registry import type_registry

SAMPLE_DIR = Path(__file__).resolve().parent.parent / "resources" / "sample entities" / "analysis_1"


class TestLoadFromSample:
    def test_load_from_sample(self):
        rec = SessionAnalysis.init_record(SAMPLE_DIR)
        assert rec.id == "analysis-1"
        assert rec.type == "session_analysis"
        assert rec.name == "Analysis of session d7dd8377"

    def test_analysis_json_property(self):
        rec = SessionAnalysis.init_record(SAMPLE_DIR)
        data = rec.analysis_json
        assert isinstance(data, dict)
        assert data["session_id"] == "d7dd8377-c888-40e5-98ea-899ed95c7eeb"
        assert isinstance(data["issues"], list)
        assert len(data["issues"]) > 0

    def test_analysis_md_property(self):
        rec = SessionAnalysis.init_record(SAMPLE_DIR)
        md = rec.analysis_md
        assert isinstance(md, str)
        assert "Session Summary" in md


class TestMissingCompanionFiles:
    def test_analysis_json_empty_when_missing(self, tmp_path):
        folder = tmp_path / "empty_analysis"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, folder
        )
        assert rec.analysis_json == {}

    def test_analysis_md_empty_when_missing(self, tmp_path):
        folder = tmp_path / "empty_analysis"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, folder
        )
        assert rec.analysis_md == ""


class TestCloneMoveDelete:
    def test_clone_copies_record(self, tmp_path):
        src = tmp_path / "src"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, src
        )
        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        assert clone.id != "a1"
        assert clone.origin_ref is not None
        assert clone.origin_ref.id == "a1"
        assert (dst / "metadata.json").exists()

    def test_clone_does_not_copy_companions(self, tmp_path):
        src = tmp_path / "src"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, src
        )
        # Write companion files to source (files live directly in record folder)
        rec.write_file("analysis.json", '{"session_id": "x"}')
        rec.write_file("analysis.md", "# Hello")
        assert (src / "analysis.json").exists()

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        # Clone only copies record metadata, not companion files
        assert not (dst / "analysis.json").exists()
        assert not (dst / "analysis.md").exists()

    def test_move_relocates_record(self, tmp_path):
        src = tmp_path / "src"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, src
        )
        dst = tmp_path / "dst"
        rec.move(dst)
        assert str(dst) in rec.source_file
        assert not src.exists()
        assert (dst / "metadata.json").exists()

    def test_delete_removes_folder(self, tmp_path):
        folder = tmp_path / "entity"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, folder
        )
        assert folder.exists()
        rec.delete()
        assert not folder.exists()
        assert rec.source_file is None
        assert rec.path is None


class TestTypeRegistration:
    def test_auto_registered(self):
        cls = type_registry.get("session_analysis")
        assert cls is SessionAnalysis


class TestCompanionFileUtilities:
    def test_write_file_creates_companion(self, tmp_path):
        folder = tmp_path / "entity"
        rec = SessionAnalysis.init_record(
            {"id": "a1", "type": "session_analysis", "name": "test"}, folder
        )
        payload = json.dumps({"session_id": "abc"})
        result = rec.write_file("analysis.json", payload)
        # Companion files live directly in the record folder (no data/ subdirectory)
        assert result == folder / "analysis.json"
        assert (folder / "analysis.json").exists()
        assert json.loads((folder / "analysis.json").read_text()) == {"session_id": "abc"}

    def test_read_file_returns_none_when_no_dir(self):
        rec = SessionAnalysis(id="a1", type="session_analysis")
        # No path or source_file set — record_dir is None
        assert rec.read_file("analysis.json") is None
