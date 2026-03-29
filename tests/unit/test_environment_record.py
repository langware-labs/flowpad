"""Tests for EnvironmentRecord."""

import json
import tempfile
from pathlib import Path

from flow_sdk.fs_records.environment_record import EnvironmentRecord
from flow_sdk.fs_store.factory.type_registry import type_registry


class TestEnvironmentRecord:
    def test_create_with_defaults(self):
        rec = EnvironmentRecord(work_dir="/tmp")
        assert rec.type == "environment"
        assert rec.work_dir == "/tmp"
        assert rec.env_vars == {}
        assert rec.compute_node_id is None

    def test_auto_registration(self):
        assert type_registry.get("environment") is EnvironmentRecord

    def test_meta_dict_contains_all_fields(self):
        rec = EnvironmentRecord(
            work_dir="/home/user",
            shell="/bin/zsh",
            compute_node_id="node-abc",
        )
        rec.env_vars = {"FOO": "bar"}
        d = rec.meta_dict()
        assert "work_dir" in d
        assert "shell" in d
        assert "env_vars" in d
        assert "compute_node_id" in d

    def test_save_writes_metadata_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            from flow_sdk.fs_store.record import set_default_records_root
            set_default_records_root(Path(tmp))
            rec = EnvironmentRecord(
                id="env-test-save",
                work_dir="/home/user",
                shell="/bin/zsh",
            )
            rec.env_vars = {"FOO": "bar"}
            rec.compute_node_id = "node-abc"
            rec.save()

            # metadata.json must exist and contain all fields
            folder = Path(rec.path)
            meta_file = folder / "metadata.json"
            assert meta_file.exists(), "metadata.json missing"
            content = json.loads(meta_file.read_text())
            data = content["data"]
            assert data["work_dir"] == "/home/user"
            assert data["shell"] == "/bin/zsh"
            assert data["env_vars"] == {"FOO": "bar"}
            assert data["compute_node_id"] == "node-abc"

    def test_round_trip_save_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            from flow_sdk.fs_store.record import set_default_records_root
            set_default_records_root(Path(tmp))
            rec = EnvironmentRecord(
                id="env-rt-1",
                work_dir="/projects/myapp",
                shell="/bin/bash",
            )
            rec.env_vars = {"HOME": "/root", "PATH": "/usr/bin"}
            rec.compute_node_id = "cn-xyz"
            rec.save()

            # Reload from folder
            rec2 = EnvironmentRecord.load_record(Path(rec.path))
            assert rec2.work_dir == "/projects/myapp"
            assert rec2.shell == "/bin/bash"
            assert rec2.env_vars == {"HOME": "/root", "PATH": "/usr/bin"}
            assert rec2.compute_node_id == "cn-xyz"

    def test_round_trip_none_compute_node_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            from flow_sdk.fs_store.record import set_default_records_root
            set_default_records_root(Path(tmp))
            rec = EnvironmentRecord(id="env-rt-2", work_dir="/tmp")
            rec.save()

            rec2 = EnvironmentRecord.load_record(Path(rec.path))
            assert rec2.compute_node_id is None
            assert rec2.work_dir == "/tmp"

    def test_setters_update_data(self):
        rec = EnvironmentRecord()
        rec.work_dir = "/new/path"
        rec.shell = "/usr/bin/fish"
        rec.compute_node_id = "node-1"
        rec.env_vars = {"X": "1"}

        assert rec.work_dir == "/new/path"
        assert rec.shell == "/usr/bin/fish"
        assert rec.compute_node_id == "node-1"
        assert rec.env_vars == {"X": "1"}

    def test_ref_properties_return_none_without_path(self):
        rec = EnvironmentRecord()
        assert rec.work_dir_ref is None
        assert rec.shell_ref is None
        assert rec.compute_node_id_ref is None
        assert rec.env_vars_ref is None
