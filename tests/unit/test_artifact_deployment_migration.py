from __future__ import annotations

import json
import sqlite3

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.migrations.artifact_deployment import migrate_artifacts, run_artifact_deployment_migration

_ENTITY_SCHEMA = """
CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    namespace TEXT,
    key TEXT,
    uname TEXT,
    type_uname TEXT,
    created_by TEXT,
    created_date TEXT,
    updated_by TEXT,
    updated_date TEXT,
    created_through TEXT,
    updated_through TEXT,
    schema_version TEXT,
    data TEXT,
    record_data_ref TEXT
)
"""


def _legacy_artifact() -> dict:
    return {
        "id": mint_uuid(),
        "type": "artifact",
        "name": "Storefront",
        "artifact_type": "WEBAPP",
        "ref_type": "FOLDER",
        "path": "/workspace/storefront",
        "description": "Example app",
        "project_id": mint_uuid(),
        "port": "8080",
        "start_cmd": "npm run dev",
        "health": "/healthz",
        "metadata": {"port": "8080", "unrelated": "legacy-only"},
    }


def _insert(conn: sqlite3.Connection, artifact: dict) -> None:
    conn.execute(
        "INSERT INTO entities (id, type, created_by, data) VALUES (?, 'artifact', 'system', ?)",
        (artifact["id"], json.dumps(artifact)),
    )


def test_migration_splits_artifact_and_local_deployment() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(_ENTITY_SCHEMA)
    legacy = _legacy_artifact()
    _insert(conn, legacy)

    report, journal = migrate_artifacts(conn)

    assert report.artifacts == 1
    assert report.deployments == 1
    assert len(journal) == 1

    artifact = json.loads(
        conn.execute("SELECT data FROM entities WHERE id = ?", (legacy["id"],)).fetchone()[0]
    )
    assert artifact["id"] == legacy["id"]
    assert artifact["kind"] == "application.web"
    assert artifact["origin"] == {"kind": "local", "base": "/workspace", "rel_path": "storefront"}
    for retired in ("artifact_type", "ref_type", "path", "metadata", "port", "start_cmd", "health"):
        assert retired not in artifact

    deployment = json.loads(
        conn.execute("SELECT data FROM entities WHERE type = 'deployment'").fetchone()[0]
    )
    assert deployment["id"] == mint_uuid(f"deployment:legacy-artifact:{legacy['id']}")
    assert is_valid_entity_id(deployment["id"])
    assert deployment["artifact_id"] == legacy["id"]
    assert deployment["kind"] == "local.runtime.web"
    assert deployment["target"]["location"] == "http://localhost:8080"
    assert deployment["provider_labels"]["flowpad.runtime.start_cmd"] == "npm run dev"


def test_migration_prefers_git_origin_and_is_idempotent() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(_ENTITY_SCHEMA)
    legacy = _legacy_artifact()
    legacy["git_origin"] = {
        "provider": "github",
        "owner": "flowpad",
        "name": "storefront",
        "branch": "main",
        "head_commit": "abc123",
        "rel_path": "apps/storefront",
    }
    _insert(conn, legacy)

    first, _ = migrate_artifacts(conn)
    second, _ = migrate_artifacts(conn)

    artifact = json.loads(conn.execute("SELECT data FROM entities WHERE type = 'artifact'").fetchone()[0])
    assert artifact["origin"]["kind"] == "git"
    assert artifact["origin"]["name"] == "storefront"
    assert first.deployments == 1
    assert second.deployments == 0
    assert conn.execute("SELECT COUNT(*) FROM entities WHERE type = 'deployment'").fetchone()[0] == 1


def test_migration_rejects_unsafe_git_origin_and_falls_back_to_local() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(_ENTITY_SCHEMA)
    legacy = _legacy_artifact()
    legacy["git_origin"] = {
        "provider": "github",
        "owner": "flowpad",
        "name": "storefront",
        "rel_path": "../../outside",
    }
    _insert(conn, legacy)

    migrate_artifacts(conn)

    artifact = json.loads(conn.execute("SELECT data FROM entities WHERE type = 'artifact'").fetchone()[0])
    assert artifact["origin"] == {
        "kind": "local",
        "base": "/workspace",
        "rel_path": "storefront",
    }


def test_file_migration_writes_backup_and_journal(tmp_path) -> None:
    db_path = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db_path)
    conn.execute(_ENTITY_SCHEMA)
    _insert(conn, _legacy_artifact())
    conn.commit()
    conn.close()

    report = run_artifact_deployment_migration(db_path)

    assert report.artifacts == 1
    assert db_path.with_suffix(".db.pre-artifact-deployment.bak").is_file()
    assert db_path.with_suffix(".db.artifact-deployment-journal.json").is_file()
