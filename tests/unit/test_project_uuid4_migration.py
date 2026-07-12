"""The 0.2.95 uuid4 project-id migration: rewrites ids + all references."""
import importlib.util
import json
import sqlite3
import uuid
from pathlib import Path

from flow_sdk.builtin.project import Project

_MIGRATE = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/migrations/0.2.95/scripts/migrate.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("_uuid4_migrate_test", _MIGRATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _schema(conn):
    conn.execute("CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, data TEXT)")
    conn.execute(
        "CREATE TABLE relationships (id TEXT PRIMARY KEY, type TEXT, from_id TEXT, "
        "from_type TEXT, to_id TEXT, to_type TEXT)"
    )
    conn.execute(
        "CREATE TABLE links (id INTEGER PRIMARY KEY, src_type TEXT, src_id TEXT, "
        "target_resolved_type TEXT, target_resolved_id TEXT)"
    )


def test_migration_rewrites_ids_edges_children_and_shadow(tmp_path):
    mod = _load_module()
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _schema(conn)

    # An unshared v5 project + a child tab + a shared v5 project (cloud_id set) +
    # an already-v4 project (must be untouched).
    v5_unshared = Project.derive_id_for_path("/work/proj-a")
    v5_shared = Project.derive_id_for_path("/work/proj-b")
    cloud = str(uuid.uuid4())
    v4_existing = str(uuid.uuid4())
    child = str(uuid.uuid4())

    conn.execute("INSERT INTO entities VALUES (?,?,?)",
                 (v5_unshared, "project", json.dumps({"id": v5_unshared, "fs_storage_mount_path": "/work/proj-a"})))
    conn.execute("INSERT INTO entities VALUES (?,?,?)",
                 (v5_shared, "project", json.dumps({"id": v5_shared, "cloud_id": cloud})))
    conn.execute("INSERT INTO entities VALUES (?,?,?)",
                 (v4_existing, "project", json.dumps({"id": v4_existing})))
    conn.execute("INSERT INTO entities VALUES (?,?,?)",
                 (child, "tab", json.dumps({"id": child, "project_id": v5_unshared})))
    # edges: project as parent (from) and as child (to)
    conn.execute("INSERT INTO relationships VALUES (?,?,?,?,?,?)",
                 ("r1", "role", v5_unshared, "project", child, "tab"))
    conn.execute("INSERT INTO relationships VALUES (?,?,?,?,?,?)",
                 ("r2", "role", "workspace-1", "workspace", v5_unshared, "project"))
    conn.execute("INSERT INTO links VALUES (?,?,?,?,?)",
                 (1, "tab", child, "project", v5_unshared))
    conn.commit()

    # shadow dir for the unshared project
    (tmp_path / "project" / f"project-@{v5_unshared}").mkdir(parents=True)

    persisted = {}
    mapping = mod._build_mapping(conn, persisted)
    # only the two v5 projects map; the v4 one is skipped
    assert set(mapping) == {v5_unshared, v5_shared}
    assert mapping[v5_shared] == cloud, "shared project reuses its cloud_id"
    assert uuid.UUID(mapping[v5_unshared]).version == 4
    new_unshared = mapping[v5_unshared]

    mod._apply_mapping(conn, mapping, tmp_path, tmp_path / "data", dry_run=False)
    conn.commit()

    # project rows now v4; cloud_id stripped
    ids = {r[0]: r[1] for r in conn.execute("SELECT id, data FROM entities WHERE type='project'")}
    assert new_unshared in ids and v5_unshared not in ids
    assert cloud in ids and v5_shared not in ids
    assert v4_existing in ids  # untouched
    assert "cloud_id" not in json.loads(ids[cloud])
    # child project_id re-pointed
    child_row = conn.execute("SELECT data FROM entities WHERE id=?", (child,)).fetchone()
    assert json.loads(child_row[0])["project_id"] == new_unshared
    # edges re-pointed (both directions)
    assert conn.execute("SELECT from_id FROM relationships WHERE id='r1'").fetchone()[0] == new_unshared
    assert conn.execute("SELECT to_id FROM relationships WHERE id='r2'").fetchone()[0] == new_unshared
    # link re-pointed
    assert conn.execute("SELECT target_resolved_id FROM links WHERE id=1").fetchone()[0] == new_unshared
    # shadow dir renamed
    assert (tmp_path / "project" / f"project-@{new_unshared}").is_dir()
    assert not (tmp_path / "project" / f"project-@{v5_unshared}").exists()


def test_migration_idempotent(tmp_path):
    """Re-running finds nothing (all projects already v4)."""
    mod = _load_module()
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _schema(conn)
    v5 = Project.derive_id_for_path("/work/x")
    conn.execute("INSERT INTO entities VALUES (?,?,?)",
                 (v5, "project", json.dumps({"id": v5, "fs_storage_mount_path": "/work/x"})))
    conn.commit()

    m1 = mod._build_mapping(conn, {})
    mod._apply_mapping(conn, m1, tmp_path, tmp_path / "data", dry_run=False)
    conn.commit()
    # second pass: no v5 projects remain
    assert mod._build_mapping(conn, {}) == {}
