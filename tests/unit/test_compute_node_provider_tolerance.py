"""Rows from a removed provider must not break the desktop, and the migration retires them."""

from __future__ import annotations

import json
import sqlite3

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.migrations.migration_2026_08_drop_docker_compute_nodes import drop, is_legacy_docker_row


def test_an_unknown_provider_hydrates_as_unset_and_use_raises_clearly():
    node = ComputeNode(name="@docker-old", node_provider_type="docker")
    assert node.node_provider_type is None
    with pytest.raises(RuntimeError, match="provider is not set"):
        _ = node.compute_provider
    assert ComputeNode(name="ok", node_provider_type="local_machine").node_provider_type == "local_machine"


def test_legacy_row_detection():
    assert is_legacy_docker_row({"node_provider_type": "docker"})
    assert is_legacy_docker_row({"uname": "docker-qa-box"})
    assert not is_legacy_docker_row({"node_provider_type": "e2b", "uname": "sandbox"})


def test_migration_drops_only_docker_rows_and_their_edges(tmp_path):
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id TEXT, type TEXT, data TEXT, created_date TEXT, updated_date TEXT)")
    conn.execute("CREATE TABLE relationships (from_id TEXT, to_id TEXT, type TEXT)")
    rows = [
        ("d1", "compute_node", {"name": "@docker-a", "node_provider_type": "docker", "uname": "docker-a"}),
        ("d2", "compute_node", {"name": "@docker-b", "uname": "docker-b"}),
        ("l1", "compute_node", {"name": "@local", "node_provider_type": "local_machine", "uname": "local"}),
        ("s1", "shell", {"name": "sh"}),
    ]
    for eid, etype, data in rows:
        conn.execute("INSERT INTO entities VALUES (?,?,?,?,?)", (eid, etype, json.dumps(data), "", ""))
    conn.execute("INSERT INTO relationships VALUES ('s1','d1','runs_on')")
    conn.execute("INSERT INTO relationships VALUES ('s1','l1','runs_on')")
    conn.commit()
    conn.close()

    preview = drop(dry_run=True, db=db)
    assert sorted(r["id"] for r in preview.rows) == ["d1", "d2"] and preview.rows_deleted == 0

    report = drop(dry_run=False, db=db)
    assert report.rows_deleted == 2 and report.relationships_deleted == 1

    conn = sqlite3.connect(db)
    assert sorted(r[0] for r in conn.execute("SELECT id FROM entities")) == ["l1", "s1"]
    assert list(conn.execute("SELECT from_id, to_id FROM relationships")) == [("s1", "l1")]
    conn.close()

    again = drop(dry_run=False, db=db)
    assert again.rows_deleted == 0


def test_migration_is_a_no_op_on_a_fresh_instance_without_schema(tmp_path):
    db = tmp_path / "fresh.db"
    sqlite3.connect(db).close()  # empty file, no tables — exactly what a first `flow start` sees
    report = drop(dry_run=False, db=db)
    assert report.rows == [] and report.rows_deleted == 0
