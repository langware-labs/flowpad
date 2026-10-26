"""The source_item identity migration over a real sqlite file (fixture DB only): flat rows are
lifted, typed rows gain (item_scope, item_key) and a payload digest, account-change twins merge
into the oldest row with their references repointed, and a second run changes nothing."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.migrations import migration_2026_10_source_item_identity as mig

SRC = "11111111-1111-4111-8111-111111111111"
FLAT, TYPED, OLD, NEW, DONE = (f"2222222{n}-2222-4222-8222-222222222222" for n in "12345")
MSG = "33333333-3333-4333-8333-333333333333"
REL = "44444444-4444-4444-8444-444444444444"
DATASET = "55555555-5555-4555-8555-555555555555"
HEADER = dict(data_source_id=SRC, provider="gmail", kind="content.message.email")


def _typed(external_id: str, namespace: str, body: str, at: str) -> dict:
    """A row as the ingestor wrote it before step 5: header + origin + data, no item_scope/key."""
    from flow_sdk.ingest.envelope_lift import data_of, origin_of
    from flow_sdk.schema.data_spec.spec import spec_tag

    mig._registered()
    header = SimpleNamespace(**HEADER, external_id=external_id, body=body, name="subj", occurred_at=at,
                             author_external_id="a@x.io", thread_key="t1")
    origin = origin_of(SimpleNamespace(channel="gmail", provider="gmail", account_key=namespace), header)
    payload = data_of(SimpleNamespace(account_key=namespace), header, origin)
    return {**vars(header), "origin": origin.model_dump(mode="json"), "origin_kind": origin.kind,
            "origin_namespace": origin.namespace, "origin_key": origin.key,
            "data": {"spec_kind": spec_tag(payload), **payload.model_dump(mode="json")}, "content_digest": "legacy"}


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "flowpad.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE entities (id VARCHAR(36) PRIMARY KEY, type VARCHAR(50), created_date DATETIME, "
                 "updated_date DATETIME, data TEXT)")
    conn.execute("CREATE TABLE relationships (id VARCHAR(36), from_id VARCHAR(36), to_id VARCHAR(36))")
    conn.execute("CREATE VIRTUAL TABLE entities_fts USING fts5(entity_id, type, name, title, description, content)")

    def put(eid, type_name, stamp, data):
        conn.execute("INSERT INTO entities VALUES (?, ?, ?, ?, ?)", (eid, type_name, stamp, stamp, json.dumps(data)))

    put(SRC, "data_source", "2026-01-01", dict(provider="gmail", channel="gmail", account_key="new@x.io"))
    # (a) flat legacy row, no data
    put(FLAT, "source_item", "2026-01-02", {**HEADER, "external_id": "f1", "body": "flat", "name": "s"})
    # (b) typed row lacking item_scope/item_key
    put(TYPED, "source_item", "2026-01-02", _typed("t1", "new@x.io", "typed", "2026-01-02T00:00:00+00:00"))
    # (c) twins from an account change: OLD minted under the former account, NEW under today's
    put(OLD, "source_item", "2026-01-03", {**_typed("m1", "old@x.io", "old body", "2026-01-03T00:00:00+00:00"),
                                          "read": True, "reactions": [{"emoji": "👍", "by": "a"}]})
    put(NEW, "source_item", "2026-01-05", {**_typed("m1", "new@x.io", "new body", "2026-01-04T00:00:00+00:00"),
                                          "starred": True, "reactions": [{"emoji": "🎉", "by": "b"}]})
    # (d) already migrated
    done = _typed("d1", "new@x.io", "done", "2026-01-02T00:00:00+00:00")
    done.update(item_scope="", item_key="d1")
    done["content_digest"] = mig._digest(done)
    put(DONE, "source_item", "2026-01-02", done)
    put(MSG, "flow_message", "2026-01-05", {"source_item_id": NEW, "origin_local": {"source_item_id": NEW}})
    put(DATASET, "dataset", "2026-01-05", {"note": f"frozen ref {NEW}"})
    conn.execute("INSERT INTO relationships VALUES (?, ?, ?)", (REL, NEW, MSG))
    conn.execute("INSERT INTO entities_fts VALUES (?, 'source_item', 'n', 'old', '', 'old body')", (OLD,))
    conn.execute("INSERT INTO entities_fts VALUES (?, 'source_item', 'n', 'new', '', 'new body')", (NEW,))
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


def _snapshot(db: Path) -> list:
    conn = sqlite3.connect(db)
    try:
        return [conn.execute("SELECT * FROM entities ORDER BY id").fetchall(),
                conn.execute("SELECT * FROM relationships").fetchall(),
                conn.execute("SELECT entity_id, content FROM entities_fts ORDER BY entity_id").fetchall()]
    finally:
        conn.close()


def test_dry_run_counts_everything_and_writes_nothing(tmp_path):
    db = _db(tmp_path)
    before = _snapshot(db)
    r = mig.migrate(db, dry_run=True)
    assert _snapshot(db) == before
    assert not mig.default_progress_path(db).exists()
    assert (r["rows_total"], r["lifted"], r["unliftable"]) == (5, 1, 0)
    assert (r["scoped_keyed"], r["scoped_by_former_account"]) == (4, 1)
    assert r["redigested"] == 4, "every row but the migrated one"
    assert (r["collision_groups"], r["rows_merged_away"]) == (1, 1)
    assert r["messages_repointed"] == 1 and r["relationships_repointed"] == 1
    assert r["per_source"][SRC]["rows_merged_away"] == 1


def test_apply_migrates_merges_into_the_oldest_and_repoints(tmp_path):
    db = _db(tmp_path)
    mig.migrate(db, dry_run=False)

    flat = _read(db, FLAT)
    assert flat["data"]["spec_kind"] and (flat["item_scope"], flat["item_key"]) == ("", "f1")
    typed = _read(db, TYPED)
    assert (typed["item_scope"], typed["item_key"]) == ("", "t1") and typed["content_digest"] == mig._digest(typed)
    assert typed["origin_namespace"] == "new@x.io", "flat header / origin_* kept (dual-write)"

    assert _read(db, NEW) is None, "the newer duplicate is merged away"
    kept = _read(db, OLD)
    assert kept["read"] and kept["starred"], "local flags OR-ed"
    assert {r["emoji"] for r in kept["reactions"]} == {"👍", "🎉"}
    assert kept["body"] == "new body" and kept["origin_namespace"] == "new@x.io", "newest payload by item time"
    assert kept["content_digest"] == mig._digest(kept)

    assert _read(db, MSG) == {"source_item_id": OLD, "origin_local": {"source_item_id": OLD}}
    assert NEW in _read(db, DATASET)["note"], "datasets are frozen"
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT from_id FROM relationships").fetchone() == (OLD,)
    assert conn.execute("SELECT entity_id, content FROM entities_fts").fetchall() == [(OLD, "new body")]
    conn.close()
    assert not mig.default_progress_path(db).exists()


def test_second_run_is_a_no_op(tmp_path):
    db = _db(tmp_path)
    mig.migrate(db, dry_run=False)
    before = _snapshot(db)
    r = mig.migrate(db, dry_run=False)
    assert _snapshot(db) == before
    assert all(r[k] == 0 for k in ("lifted", "scoped_keyed", "redigested", "collision_groups", "references_repointed"))


def test_resumes_after_a_stop_mid_pass(tmp_path):
    db = _db(tmp_path)
    with pytest.raises(mig._Stopped):
        mig.migrate(db, dry_run=False, batch_size=2, stop_after_batches=1)
    marker = json.loads(mig.default_progress_path(db).read_text())
    assert marker["last_rowid"] > 0
    assert "item_key" in _read(db, FLAT) and "item_key" not in _read(db, OLD), "first batch committed, rest not"

    r = mig.migrate(db, dry_run=False, batch_size=2)
    assert r["resumed_from_rowid"] == marker["last_rowid"]
    assert r["rows_seen"] < r["rows_total"], "did not redo the committed batch"
    assert _read(db, NEW) is None and _read(db, OLD)["item_key"] == "m1"
    assert not mig.default_progress_path(db).exists()


def test_unliftable_row_is_counted_and_left(tmp_path):
    db = _db(tmp_path)
    conn = sqlite3.connect(db)
    blank = "66666666-6666-4666-8666-666666666666"
    conn.execute("INSERT INTO entities VALUES (?, 'source_item', '2026-01-02', '2026-01-02', ?)",
                 (blank, json.dumps({**HEADER, "external_id": ""})))
    conn.commit()
    conn.close()
    r = mig.migrate(db, dry_run=False)
    assert r["unliftable"] == 1 and blank in r["unliftable_ids"]
    assert "item_key" not in _read(db, blank)


def test_cli_dry_run(tmp_path, capsys):
    db = _db(tmp_path)
    assert mig.main(["--db", str(db), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "collision_groups" in out and SRC in out
