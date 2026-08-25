"""Unit tests for the unified declarative Entity↔Record (FS) sync.

Covers every sync mode, bidirectional:

  - DB→disk: ``persist`` resolution (TRUE/FALSE/DEFAULT against the type's
    metadata model), ``FSRecord.save_metadata`` partial-merge, None-no-clobber,
    ``save_metadata_field`` single-key writes.
  - disk→DB: ``Entity.from_record`` hydration; FALSE fields come from
    defaults, never disk.
  - No-write-back: the disk→DB adopt path never rewrites metadata.json
    (structural loop suppression).
  - Round-trip: disk → DB → (app save) → disk is stable for persisted fields.

All ≤5s, real FSRecord + SQLite, no mocks of the units under test.
"""
import json
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from pydantic import BaseModel

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.fs_store.fs_record import FSRecord, _json_default
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.datum import Datum


# ── Test type: one field per persist policy ──────────────────────────────────

class _SyncMeta(BaseModel):
    """FS metadata schema for the test type. DEFAULT fields persist iff named here."""
    name: str | None = None
    status: str | None = None


class _SyncEntity(Entity):
    type: str = "test_sync"
    # DEFAULT (implicit) + in _SyncMeta  → persisted
    name: str | None = APIField(default=None)
    status: str | None = APIField(default=None)
    # FALSE → never persisted (runtime/computed)
    tab_order: int = APIField(default=0, persist=Persist.FALSE)
    # TRUE → always persisted, even though absent from _SyncMeta
    forced: str | None = APIField(default=None, persist=Persist.TRUE)
    # DEFAULT but NOT in _SyncMeta → not persisted
    ghost: str | None = APIField(default=None)
    # A MODEL-valued persisted field (Dataset.contract is the real one).
    contract: Datum | None = APIField(default=None, persist=Persist.TRUE)


def _register_meta_model():
    info = SchemaRegistry.get("test_sync")
    assert info is not None, "_SyncEntity should auto-register via __init_subclass__"
    info.meta_model = _SyncMeta


_register_meta_model()

# Ensure per-type metadata models (ShellMeta, ProjectMeta, …) are registered on
# their TypeInfo so the builtin-type round-trip tests resolve persist=DEFAULT
# against the real meta_model rather than the BaseMeta fallback.
from flow_sdk.schema.type_info import register_all as _register_all  # noqa: E402
_register_all()


@pytest_asyncio.fixture
async def sync_db(tmp_path):
    """Isolated SQLite driver bound to Entity for the bidirectional tests."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "record_sync.db")
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver

    yield driver

    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()


def _meta_on_disk(rec: FSRecord) -> dict:
    path = rec.shadow_dir / "metadata.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


# ── 1. FSRecord-level partial-merge writers (pure, no DB) ─────────────────────

class TestSaveMetadata:
    def test_save_metadata_writes_patch(self):
        rec = FSRecord(type="test_sync", id="11111111-1111-1111-1111-111111111111")
        rec.save_metadata({"name": "alpha", "status": "running"})
        disk = _meta_on_disk(rec)
        assert disk["name"] == "alpha"
        assert disk["status"] == "running"
        assert disk["type"] == "test_sync"
        assert disk["id"] == "11111111-1111-1111-1111-111111111111"

    def test_save_metadata_partial_merge_preserves_unrelated(self):
        rec = FSRecord(type="test_sync", id="22222222-2222-2222-2222-222222222222")
        rec.save_metadata({"name": "alpha", "status": "running"})
        rec.save_metadata({"status": "closed"})  # partial
        disk = _meta_on_disk(rec)
        assert disk["status"] == "closed"
        assert disk["name"] == "alpha", "unmentioned key must survive a partial write"

    def test_save_metadata_none_does_not_clobber(self):
        rec = FSRecord(type="test_sync", id="33333333-3333-3333-3333-333333333333")
        rec.save_metadata({"name": "alpha"})
        rec.save_metadata({"name": None, "status": "running"})  # None skipped
        disk = _meta_on_disk(rec)
        assert disk["name"] == "alpha", "None value must not overwrite an existing field"
        assert disk["status"] == "running"

    def test_save_metadata_field_single_key(self):
        rec = FSRecord(type="test_sync", id="44444444-4444-4444-4444-444444444444")
        rec.save_metadata({"name": "alpha", "status": "running"})
        rec.save_metadata_field("status", "closed")
        disk = _meta_on_disk(rec)
        assert disk["status"] == "closed"
        assert disk["name"] == "alpha"

    def test_current_meta_keys(self):
        rec = FSRecord(type="test_sync", id="55555555-5555-5555-5555-555555555555")
        assert rec.current_meta_keys() == set()
        rec.save_metadata({"name": "alpha", "status": "running"})
        assert {"name", "status"}.issubset(rec.current_meta_keys())


class TestModelValuedFields:
    """metadata.json is written with a ``default=`` hook, so a value json.dumps
    cannot handle never raises — it is coerced. Before ``_json_default``, a
    Pydantic model fell to ``str`` and was written as its REPR
    (``"kind='array' fields=None …"``), which re-reads as a string and fails
    validation on the next load: silent corruption, with no exception to notice
    it by. These pin the encode, not an exception."""

    def test_a_model_value_is_written_as_json_not_a_repr(self, tmp_path):
        rec = FSRecord(type="test_sync", id=str(uuid.uuid4()))
        rec.save_metadata({"contract": Datum(kind="array", items=[Datum(kind="string")])})
        on_disk = _meta_on_disk(rec)["contract"]
        assert isinstance(on_disk, dict), f"written as {type(on_disk).__name__}: {on_disk!r}"
        assert on_disk["kind"] == "array"
        assert Datum.model_validate(on_disk).items[0].kind == "string"  # re-reads

    def test_a_collection_of_models_is_encoded_too(self):
        """The coercion belongs to the WRITER, so it reaches values a per-field
        branch on the producer would miss — a list or dict of models."""
        encoded = json.loads(json.dumps(
            {"many": [Datum(value=1)], "by_name": {"a": Datum(value=2)}},
            default=_json_default,
        ))
        assert encoded["many"][0]["value"] == 1
        assert encoded["by_name"]["a"]["value"] == 2

    def test_an_unknown_type_keeps_the_historical_str_coercion(self):
        assert json.loads(json.dumps({"p": Path("/x/y")}, default=_json_default))["p"] == "/x/y"


# ── 2. persist resolution → metadata_payload (pure, no DB) ────────────────────

class TestPersistResolution:
    def test_payload_includes_default_in_model_and_forced(self):
        e = _SyncEntity(name="alpha", status="running", tab_order=5, forced="f", ghost="g")
        payload = e.metadata_payload()
        assert payload.get("name") == "alpha"      # DEFAULT, in _SyncMeta
        assert payload.get("status") == "running"  # DEFAULT, in _SyncMeta
        assert payload.get("forced") == "f"        # TRUE, not in _SyncMeta but forced

    def test_payload_excludes_false_and_default_not_in_model(self):
        e = _SyncEntity(name="alpha", tab_order=5, ghost="g")
        payload = e.metadata_payload()
        assert "tab_order" not in payload, "persist=FALSE must never be written"
        assert "ghost" not in payload, "DEFAULT field absent from meta_model must not persist"

    def test_payload_excludes_none(self):
        e = _SyncEntity(name="alpha")  # status/forced left None
        payload = e.metadata_payload()
        assert "name" in payload
        assert "status" not in payload
        assert "forced" not in payload


# ── 3. DB→disk and disk→DB round-trip (DB-backed) ────────────────────────────

class TestBidirectional:
    @pytest.mark.asyncio
    async def test_store_writes_persisted_fields_to_disk(self, sync_db):
        e = _SyncEntity(name="alpha", status="running", tab_order=7, forced="f", ghost="g")
        await e.save()
        rec = FSRecord.load("test_sync", e.id)
        disk = _meta_on_disk(rec)
        assert disk["name"] == "alpha"
        assert disk["status"] == "running"
        assert disk["forced"] == "f"
        assert "tab_order" not in disk, "persist=FALSE field must not reach disk"
        assert "ghost" not in disk, "DEFAULT field not in meta_model must not reach disk"

    @pytest.mark.asyncio
    async def test_from_record_hydrates_entity(self, sync_db):
        rec = FSRecord(type="test_sync", id="66666666-6666-6666-6666-666666666666")
        rec.save_metadata({"name": "beta", "status": "idle"})
        entity = await Entity.from_record(rec)
        assert entity.name == "beta"
        assert entity.status == "idle"

    @pytest.mark.asyncio
    async def test_round_trip_stable(self, sync_db):
        e = _SyncEntity(name="alpha", status="running", forced="f")
        await e.save()
        rec = FSRecord.load("test_sync", e.id)
        before = _meta_on_disk(rec)

        rehydrated = await Entity.from_record(rec)
        rehydrated.status = "closed"
        await rehydrated.save()

        after = _meta_on_disk(FSRecord.load("test_sync", e.id))
        assert after["status"] == "closed"
        assert after["name"] == before["name"]
        assert after["forced"] == before["forced"]


# ── 3b. Real builtin types: Shell + Project round-trip via the generic path ──

class TestBuiltinTypes:
    @pytest.mark.asyncio
    async def test_shell_store_persists_domain_fields(self, sync_db):
        from flow_sdk.builtin.shell import Shell
        sh = Shell(
            id="88888888-8888-8888-8888-888888888888",
            name="my tab", status="running", workdir="/tmp", pty_pid="p1",
            tab_order=3,
        )
        await sh.save()
        disk = _meta_on_disk(FSRecord.load("shell", sh.id))
        assert disk["name"] == "my tab"
        assert disk["status"] == "running"
        assert disk["workdir"] == "/tmp"
        assert disk["pty_pid"] == "p1"
        # tab_order is DB-only (persist=FALSE) — never mirrored to disk.
        assert "tab_order" not in disk

    @pytest.mark.asyncio
    async def test_shell_from_record_generic(self, sync_db):
        from flow_sdk.builtin.shell import Shell
        rec = FSRecord(type="shell", id="99999999-9999-9999-9999-999999999999")
        rec.save_metadata({"name": "t2", "status": "idle", "workdir": "/x", "pty_pid": "p2"})
        sh = await Shell.from_record(rec)
        assert sh.name == "t2"
        assert sh.status == "idle"
        assert sh.workdir == "/x"
        assert sh.pty_pid == "p2"

    @pytest.mark.asyncio
    async def test_project_denorm_fields_not_persisted(self, sync_db):
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        p = Project(fs_storage_mount_path=canonical_posix_path("/tmp/projA"))
        p.id = Project.allocate_id({"fs_storage_mount_path": p.fs_storage_mount_path})
        p.session_count = 7
        p.last_session_at = "2026-05-30T00:00:00Z"
        await p.save()
        disk = _meta_on_disk(FSRecord.load("project", p.id))
        assert "session_count" not in disk, "denormalized DB-only field must not reach disk"
        assert "last_session_at" not in disk
        assert disk.get("fs_storage_mount_path") == p.fs_storage_mount_path


# ── 4. No write-back on the adopt path (structural loop suppression) ──────────

class TestNoWriteBack:
    @pytest.mark.asyncio
    async def test_from_record_does_not_rewrite_disk(self, sync_db):
        rec = FSRecord(type="test_sync", id="77777777-7777-7777-7777-777777777777")
        rec.save_metadata({"name": "gamma", "status": "idle"})
        meta_path = rec.shadow_dir / "metadata.json"
        mtime_before = meta_path.stat().st_mtime_ns

        await Entity.from_record(rec)  # disk→DB adopt

        mtime_after = meta_path.stat().st_mtime_ns
        assert mtime_after == mtime_before, (
            "disk→DB adopt must not rewrite metadata.json — that is the indexer loop"
        )
