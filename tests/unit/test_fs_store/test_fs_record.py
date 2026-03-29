"""Tests for Record -- filesystem I/O (from_json / to_json / persist)."""

import json

import pytest
from flow_sdk.fs_store import Record, RecordRef, Scope
from flow_sdk.fs_records import AgenticProcessRecord, AgenticProcessStatus, TaskResource, TaskStatus, TaskType

# ---------------------------------------------------------------------------
# from_json / to_json
# ---------------------------------------------------------------------------

class TestJsonIO:
    def test_to_json_creates_file(self, tmp_path):
        r = Record(id="1", name="test")
        fp = tmp_path / "rec.json"
        r.save_record_json(fp)
        assert fp.exists()
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["id"] == "1"

    def test_from_json_existing(self, tmp_path):
        fp = tmp_path / "rec.json"
        fp.write_text(json.dumps({"id": "x", "name": "loaded"}))
        r = Record.load_record(fp)
        assert r.id == "x"
        assert r.name == "loaded"
        assert r.source_file == str(fp)

    def test_from_json_missing_creates_new(self, tmp_path):
        fp = tmp_path / "missing.json"
        r = Record.load_record(fp)
        assert r.source_file == str(fp)
        assert r.id  # auto-generated uuid

    def test_round_trip_json_file(self, tmp_path):
        fp = tmp_path / "rt.json"
        r = Record(id="rt", type="session", name="s1",
                      scope=Scope.PROJECT, k="v")
        r.save_record_json(fp)
        r2 = Record.load_record(fp)
        assert r2.id == "rt"
        assert r2.scope == Scope.PROJECT
        assert r2["k"] == "v"

    def test_to_json_creates_parent_dirs(self, tmp_path):
        fp = tmp_path / "a" / "b" / "rec.json"
        r = Record(id="nested")
        r.save_record_json(fp)
        assert fp.exists()

    def test_to_json_defaults_to_source_file(self, tmp_path):
        fp = tmp_path / "auto.json"
        r = Record(id="auto")
        r.save_record_json(fp)  # sets source_file
        r["tag"] = "updated"
        r.save_record_json()  # should write to same path
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["tag"] == "updated"


# ---------------------------------------------------------------------------
# persist
# ---------------------------------------------------------------------------

class TestPersist:
    def test_persist(self, tmp_path):
        fp = tmp_path / "rec.json"
        r = Record.load_record(fp)
        r["key"] = "val"
        r.save()
        assert fp.exists()
        raw = json.loads(fp.read_text())
        data = raw.get("data", raw)
        assert data["key"] == "val"

    def test_persist_without_source_file_raises(self):
        r = Record()
        r.source_file = None
        with pytest.raises(ValueError):
            r.save()


# ---------------------------------------------------------------------------
# Children + JSON file round-trip
# ---------------------------------------------------------------------------

class TestChildrenFileIO:
    def test_children_refs_json_file_round_trip(self, tmp_path):
        fp = tmp_path / "nested.json"
        parent = Record(id="p", type="session")
        parent.children_refs = [
            RecordRef(id="c1", type="step"),
            RecordRef(id="c2", type="step"),
        ]
        parent.save_record_json(fp)

        loaded = Record.load_record(fp)
        assert len(loaded.children_refs) == 2
        assert isinstance(loaded.children_refs[0], RecordRef)
        assert loaded.children_refs[0].id == "c1"


# ---------------------------------------------------------------------------
# Record is a Record
# ---------------------------------------------------------------------------

class TestInheritance:
    def test_isinstance(self):
        r = Record(id="x")
        assert isinstance(r, Record)

    def test_meta_dict_works(self):
        r = Record(id="x", name="fs", k="v")
        d = r.meta_dict()
        assert d["id"] == "x"
        assert d["k"] == "v"

    def test_from_dict_works(self):
        r = Record.from_dict({"id": "x", "name": "loaded"})
        assert r.id == "x"
        assert isinstance(r, Record)

    def test_kv_access(self):
        r = Record()
        r["foo"] = "bar"
        assert r["foo"] == "bar"
        assert "foo" in r


# ---------------------------------------------------------------------------
# Parent-child hierarchy with concrete record types
# ---------------------------------------------------------------------------

class TestParentChildRecord:
    def test_task_with_agentic_process_child_refs_round_trip(self, tmp_path):
        fp = tmp_path / "task.json"
        task = TaskResource(
            id="task-1",
            title="Analysis",
            status=TaskStatus.IN_PROGRESS,
            task_type=TaskType.ANALYSIS,
        )
        process = AgenticProcessRecord(
            id="proc-1",
            state=AgenticProcessStatus.RUNNING,
            worker_id="session-1",
            parent_ref=RecordRef(id="task-1", type="task"),
        )
        task.children_refs = [RecordRef.from_record(process)]
        task.save_record_json(fp)

        loaded = Record.load_record(fp)
        assert loaded.id == "task-1"
        assert len(loaded.children_refs) == 1
        child_ref = loaded.children_refs[0]
        assert isinstance(child_ref, RecordRef)
        assert child_ref.id == "proc-1"

    def test_parent_ref_persists_through_file_io(self, tmp_path):
        fp = tmp_path / "record.json"
        r = Record(id="child-rec", parent_ref=RecordRef(id="parent-rec", type="session"))
        r.save_record_json(fp)

        loaded = Record.load_record(fp)
        assert isinstance(loaded.parent_ref, RecordRef)
        assert loaded.parent_ref.id == "parent-rec"


# ---------------------------------------------------------------------------
# Live parent/children properties -- resolve refs from distributed folders
# ---------------------------------------------------------------------------

class TestLiveParentProperty:
    def test_parent_returns_none_when_no_ref(self):
        r = Record(id="orphan")
        assert r.parent is None

    def test_parent_returns_none_when_no_record_path(self):
        r = Record(id="child", parent_ref=RecordRef(id="p", type="task"))
        assert r.parent is None

    def test_parent_returns_none_when_file_missing(self):
        r = Record(
            id="child",
            parent_ref=RecordRef(id="p", type="task", path="/nonexistent/p.json"),
        )
        assert r.parent is None

    def test_parent_loads_from_disk(self, tmp_path):
        # Save parent in one folder
        parent_fp = tmp_path / "folder_a" / "parent.json"
        parent = Record(id="p", type="task", name="Parent Task")
        parent.save_record_json(parent_fp)

        # Child in a different folder points to parent via path
        child = Record(
            id="c",
            type="process",
            parent_ref=RecordRef(id="p", type="task", path=str(parent_fp)),
        )

        loaded_parent = child.parent
        assert loaded_parent is not None
        assert loaded_parent.id == "p"
        assert loaded_parent.name == "Parent Task"

    def test_parent_loaded_across_folders(self, tmp_path):
        """Parent and child live in completely separate directory trees."""
        parent_fp = tmp_path / "projects" / "alpha" / "task.json"
        child_fp = tmp_path / "workers" / "beta" / "process.json"

        parent = Record(id="task-1", type="task", name="Alpha Task")
        parent.save_record_json(parent_fp)

        child = Record(
            id="proc-1",
            type="process",
            parent_ref=RecordRef(id="task-1", type="task", path=str(parent_fp)),
        )
        child.save_record_json(child_fp)

        # Reload child from disk, then resolve parent
        reloaded = Record.load_record(child_fp)
        live_parent = reloaded.parent
        assert live_parent is not None
        assert live_parent.id == "task-1"
        assert live_parent.name == "Alpha Task"


class TestLiveChildrenProperty:
    def test_children_empty_when_no_refs(self):
        r = Record(id="leaf")
        assert r.children == []

    def test_children_skips_refs_without_record_path(self):
        r = Record(
            id="p",
            children_refs=[RecordRef(id="c1", type="step")],
        )
        assert r.children == []

    def test_children_skips_missing_files(self):
        r = Record(
            id="p",
            children_refs=[
                RecordRef(id="c1", type="step", path="/nonexistent/c1.json"),
            ],
        )
        assert r.children == []

    def test_children_loads_from_disk(self, tmp_path):
        # Save two children in separate folders
        c1_fp = tmp_path / "steps" / "c1.json"
        c2_fp = tmp_path / "steps" / "c2.json"
        Record(id="c1", type="step", name="Step One").save_record_json(c1_fp)
        Record(id="c2", type="step", name="Step Two").save_record_json(c2_fp)

        parent = Record(
            id="p",
            type="session",
            children_refs=[
                RecordRef(id="c1", type="step", path=str(c1_fp)),
                RecordRef(id="c2", type="step", path=str(c2_fp)),
            ],
        )

        kids = parent.children
        assert len(kids) == 2
        assert kids[0].id == "c1"
        assert kids[0].name == "Step One"
        assert kids[1].id == "c2"

    def test_children_distributed_across_folders(self, tmp_path):
        """Each child record lives in a completely different directory tree."""
        c1_fp = tmp_path / "region_us" / "worker_a" / "step.json"
        c2_fp = tmp_path / "region_eu" / "worker_b" / "step.json"
        Record(id="c1", type="step", name="US Step").save_record_json(c1_fp)
        Record(id="c2", type="step", name="EU Step").save_record_json(c2_fp)

        parent_fp = tmp_path / "orchestrator" / "session.json"
        parent = Record(
            id="sess",
            type="session",
            children_refs=[
                RecordRef(id="c1", type="step", path=str(c1_fp)),
                RecordRef(id="c2", type="step", path=str(c2_fp)),
            ],
        )
        parent.save_record_json(parent_fp)

        # Reload parent from disk, then resolve children
        reloaded = Record.load_record(parent_fp)
        kids = reloaded.children
        assert len(kids) == 2
        assert {k.name for k in kids} == {"US Step", "EU Step"}

    def test_children_skips_missing_but_loads_existing(self, tmp_path):
        """Partial resolution: one child exists on disk, another doesn't."""
        c1_fp = tmp_path / "c1.json"
        Record(id="c1", type="step", name="Exists").save_record_json(c1_fp)

        parent = Record(
            id="p",
            children_refs=[
                RecordRef(id="c1", type="step", path=str(c1_fp)),
                RecordRef(id="c2", type="step", path="/gone/c2.json"),
                RecordRef(id="c3", type="step"),  # no path
            ],
        )

        kids = parent.children
        assert len(kids) == 1
        assert kids[0].id == "c1"

    def test_get_children_by_type_filters_children(self, tmp_path):
        c1_fp = tmp_path / "step.json"
        c2_fp = tmp_path / "process.json"
        Record(id="c1", type="step", name="Step One").save_record_json(c1_fp)
        Record(id="c2", type="process", name="Process One").save_record_json(c2_fp)

        parent = Record(
            id="p",
            children_refs=[
                RecordRef(id="c1", type="step", path=str(c1_fp)),
                RecordRef(id="c2", type="process", path=str(c2_fp)),
            ],
        )

        step_children = parent.get_children_by_type("step")
        assert len(step_children) == 1
        assert step_children[0].id == "c1"

    def test_get_children_by_type_returns_empty_when_no_matches(self, tmp_path):
        c1_fp = tmp_path / "step.json"
        Record(id="c1", type="step").save_record_json(c1_fp)

        parent = Record(
            id="p",
            children_refs=[RecordRef(id="c1", type="step", path=str(c1_fp))],
        )

        assert parent.get_children_by_type("process") == []


class TestAddChild:
    def test_add_child_from_record_adds_ref_and_resolves_child(self, tmp_path):
        child_fp = tmp_path / "workers" / "a" / "child.json"
        child = Record(id="c1", type="step", name="Child One")
        child.save_record_json(child_fp)

        parent = Record(id="p", type="session")
        added_ref = parent.add_child(child)

        assert isinstance(added_ref, RecordRef)
        assert len(parent.children_refs) == 1
        assert parent.children_refs[0].id == "c1"
        assert parent.children_refs[0].path == str(child_fp)

        kids = parent.children
        assert len(kids) == 1
        assert kids[0].id == "c1"
        assert kids[0].name == "Child One"

    def test_add_child_from_ref_keeps_ref_only_and_does_not_create_child_file(self, tmp_path):
        missing_child_fp = tmp_path / "missing" / "child.json"
        parent = Record(id="p", type="session")

        parent.add_child(RecordRef(id="ghost", type="step", path=str(missing_child_fp)))

        assert len(parent.children_refs) == 1
        assert parent.children_refs[0].id == "ghost"
        assert not missing_child_fp.exists()
        assert parent.children == []

    def test_add_child_dedupes_same_child_by_id_and_type(self, tmp_path):
        child_fp = tmp_path / "child.json"
        child = Record(id="c1", type="step")
        child.save_record_json(child_fp)

        parent = Record(id="p", type="session")
        parent.add_child(child)
        parent.add_child(child)
        parent.add_child(RecordRef(id="c1", type="step", path="/other/path.json"))

        assert len(parent.children_refs) == 1
        assert parent.children_refs[0].path == str(child_fp)

    def test_add_child_persists_parent_when_parent_has_source_file(self, tmp_path):
        parent_fp = tmp_path / "orchestrator" / "session.json"
        parent = Record(id="p", type="session")
        parent.save_record_json(parent_fp)

        child_fp = tmp_path / "steps" / "step.json"
        child = Record(id="c1", type="step")
        child.save_record_json(child_fp)

        parent.add_child(child)

        reloaded_parent = Record.load_record(parent_fp)
        assert len(reloaded_parent.children_refs) == 1
        assert reloaded_parent.children_refs[0].id == "c1"
        assert reloaded_parent.children_refs[0].path == str(child_fp)

    def test_add_child_with_children_all_over_folders(self, tmp_path):
        c1_fp = tmp_path / "region_us" / "worker_a" / "step.json"
        c2_fp = tmp_path / "region_eu" / "worker_b" / "step.json"
        Record(id="c1", type="step", name="US Step").save_record_json(c1_fp)
        Record(id="c2", type="step", name="EU Step").save_record_json(c2_fp)

        parent_fp = tmp_path / "orchestrator" / "session.json"
        parent = Record(id="sess", type="session")
        parent.save_record_json(parent_fp)

        parent.add_child(Record.load_record(c1_fp))
        parent.add_child(Record.load_record(c2_fp))

        reloaded_parent = Record.load_record(parent_fp)
        kids = reloaded_parent.children
        assert len(kids) == 2
        assert {k.name for k in kids} == {"US Step", "EU Step"}


class TestLiveRoundTrip:
    def test_full_hierarchy_across_folders(self, tmp_path):
        """Build a parent->child hierarchy where each record is in its own folder,
        save all to disk, then resolve the full tree from any starting point."""
        parent_fp = tmp_path / "tasks" / "task.json"
        child_fp = tmp_path / "processes" / "proc.json"

        # Create and save child first (so we know its path for the ref)
        child = Record(id="proc-1", type="process", name="Worker")
        child.save_record_json(child_fp)

        # Create parent with ref pointing to saved child
        parent = Record(
            id="task-1",
            type="task",
            name="Analysis",
            children_refs=[RecordRef(id="proc-1", type="process", path=str(child_fp))],
        )
        parent.save_record_json(parent_fp)

        # Update child with ref pointing back to parent
        child.parent_ref = RecordRef(id="task-1", type="task", path=str(parent_fp))
        child.save_record_json()

        # Now verify: load parent -> resolve children -> from child resolve parent
        loaded_parent = Record.load_record(parent_fp)
        kids = loaded_parent.children
        assert len(kids) == 1
        assert kids[0].id == "proc-1"
        assert kids[0].name == "Worker"

        # From child, resolve back to parent
        grandparent = kids[0].parent
        assert grandparent is not None
        assert grandparent.id == "task-1"
        assert grandparent.name == "Analysis"
