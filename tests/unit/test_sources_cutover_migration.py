"""The cutover migration over a real sqlite file: rows gain their origin, twins collapse,
messages follow their row, and a second run changes nothing."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from flow_sdk.migrations import migration_2026_09_sources_cutover as mig

SRC = "11111111-1111-4111-8111-111111111111"
OLD, NEW, ALONE, BLANK = (f"2222222{n}-2222-4222-8222-222222222222" for n in "1234")
MSG = "33333333-3333-4333-8333-333333333333"


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) PRIMARY KEY, type VARCHAR(50), created_date DATETIME, "
                 "updated_date DATETIME, data TEXT)")
    conn.execute("CREATE TABLE relationships (from_id VARCHAR(36), to_id VARCHAR(36))")

    def put(eid, type_name, stamp, **data):
        conn.execute("INSERT INTO entities VALUES (?, ?, ?, ?, ?)", (eid, type_name, stamp, stamp, json.dumps(data)))

    put(SRC, "data_source", "2026-01-01", provider="agent", channel="slack", account_key="T1")
    header = dict(data_source_id=SRC, provider="agent", kind="content.message.chat", segment_key="C1")
    put(OLD, "source_item", "2026-01-02", **header, external_id="17", body="old", read=True)
    put(NEW, "source_item", "2026-01-03", **header, external_id="17", body="new")
    put(ALONE, "source_item", "2026-01-02", **header, external_id="18", body="x", starred=True)
    put(BLANK, "source_item", "2026-01-02", **{**header, "external_id": ""})
    put(MSG, "flow_message", "2026-01-02", source_item_id=OLD, origin_local={"data_source_id": SRC, "source_item_id": OLD},
        origin={"kind": "slack", "external_id": "17", "url": "https://slack.test/17"})
    conn.commit()
    conn.close()
    return db


def _read(db: Path, eid: str) -> dict | None:
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("SELECT data FROM entities WHERE id = ?", (eid,)).fetchone()
        return json.loads(row[0]) if row else None
    finally:
        conn.close()


def test_a_dry_run_reports_and_writes_nothing(tmp_path):
    db = _db(tmp_path)
    report = mig.migrate(dry_run=True, db=db)
    assert (report.rows_lifted, report.duplicates_removed, report.rows_unliftable) == (3, 1, 1)
    assert (report.messages_repointed, report.messages_reoriginated) == (1, 1)
    assert "origin" not in _read(db, NEW) and _read(db, OLD) is not None


def test_apply_lifts_collapses_repoints_and_converges(tmp_path):
    db = _db(tmp_path)
    mig.migrate(dry_run=False, db=db)

    kept = _read(db, NEW)
    assert (kept["origin_kind"], kept["origin_namespace"], kept["origin_key"]) == ("slack", "T1/C1", "17")
    assert kept["data"]["spec_kind"] == "ingest.message" and kept["read"] is True, "newest survives, local state merged"
    assert _read(db, OLD) is None and _read(db, ALONE)["starred"] is True
    assert "origin" not in _read(db, BLANK), "a row that names no origin is left alone"

    msg = _read(db, MSG)
    assert msg["source_item_id"] == NEW and msg["origin_local"]["source_item_id"] == NEW
    assert msg["origin"] == {"kind": "slack", "namespace": "T1/C1", "key": "17", "url": "https://slack.test/17"}

    again = mig.migrate(dry_run=False, db=db)
    assert not again.changed and again.rows_unliftable == 1
