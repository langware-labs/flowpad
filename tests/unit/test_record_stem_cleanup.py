"""The record-stem cleanup: canonical ``<type>-<id>`` (no uname ``@``), a
back-compat reader for the legacy ``<type>-@<id>`` shape, and the 0.2.103
folder-rename migration.

  * ``record_stem`` builds ``<type>-<id>``; ``parse_record_stem`` splits on the
    first ``-`` and also tolerates a legacy ``<type>-@<id>`` token.
  * A ``.flowmsg`` bundle whose attachment arc was written in the OLD ``-@`` form
    still unpacks + installs (the unpack side canonicalizes the arc).
  * The migration renames ``records/<type>/<type>-@<id>/`` → ``records/<type>/<id>/``,
    canonicalizes nested staging arcs, and rewrites MessageAttachment path fields.
"""
from __future__ import annotations

import importlib.util
import json
import zipfile
from pathlib import Path

import pytest

from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR
from flow_sdk.fs_store.record_paths import parse_record_stem, record_stem

pytestmark = [pytest.mark.timeout(30)]  # do not increase without approval


# ── the seam ────────────────────────────────────────────────────────────────
def test_record_stem_is_canonical_no_at():
    stem = record_stem("task", "3bd9d5f6-0000-4000-8000-000000000001")
    assert stem == "task-3bd9d5f6-0000-4000-8000-000000000001"
    assert "@" not in stem


def test_parse_record_stem_first_dash_and_legacy():
    # New canonical form — id may itself contain hyphens (a UUID).
    assert parse_record_stem("task-abc-def-01") == ("task", "abc-def-01")
    # Legacy uname-sigil form still parses (the ``@`` is stripped).
    assert parse_record_stem("task-@abc-def-01") == ("task", "abc-def-01")
    # A genuine uname reference round-trips its name (sans sigil) — never fed a
    # record id, but must not raise.
    assert parse_record_stem("compute_node-@local") == ("compute_node", "local")


# ── env for the bundle + migration tests ────────────────────────────────────
@pytest.fixture
def env(tmp_path, monkeypatch):
    from flow_sdk.config import default_service_config
    from flow_sdk.fs_store.record_paths import (
        get_default_records_data_root,
        get_default_records_root,
        set_default_records_data_root,
        set_default_records_root,
    )
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    home = tmp_path / "home"
    home.mkdir()
    records = tmp_path / "records"
    records.mkdir()
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(records)
    set_default_records_data_root(records)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    monkeypatch.setenv("FLOWPAD_TEST_SANDBOX", str(home))
    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(records / "blobs")))
    reset_instance_settings()
    try:
        yield tmp_path
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)
        reset_instance_settings()


def _rewrite_zip_arcs_to_legacy(src: Path, dst: Path) -> None:
    """Copy a .flowmsg, rewriting every ``attachment/<type>-<id>/…`` arc into the
    legacy ``attachment/<type>-@<id>/…`` form — simulating a bundle produced by a
    build from before the cleanup."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            data = zin.read(item)
            new = item
            for prefix in ("attachment/", "metadata/"):
                if item.startswith(prefix):
                    rest = item[len(prefix):]
                    seg, sep, tail = rest.partition("/")
                    t, dash, i = seg.partition("-")
                    if dash:
                        seg = f"{t}-@{i}"
                    new = f"{prefix}{seg}{sep}{tail}"
                    break
            zout.writestr(new, data)


@pytest.mark.asyncio
async def test_legacy_dash_at_bundle_still_unpacks_and_installs(env):
    """A .flowmsg whose arc uses the retired ``task-@<id>`` shape must still stage
    + install — the unpack side canonicalizes the arc so install (record_stem)
    finds it."""
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle, unpack_bundle
    from flow_sdk.builtin.message_attachment import MessageAttachment
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.task import Task

    parent = Task(title="Legacy Ship", status="in_progress")
    await parent.save(notify=False)

    fm = FlowMessage(id="aaaaaaaa-0000-4000-8000-000000000010", text="carrier")
    fm.attachment = [Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"task-{parent.id}")]
    zip_path = await pack_bundle(fm, dest_dir=env / "out")

    # Sanity: a freshly packed bundle is canonical (no ``-@``)…
    with zipfile.ZipFile(zip_path) as zf:
        assert any(n.startswith(f"attachment/task-{parent.id}/") for n in zf.namelist())
        assert not any("-@" in n for n in zf.namelist())

    # …now forge the legacy shape and unpack THAT.
    legacy_zip = env / "out" / "legacy.flowmsg"
    _rewrite_zip_arcs_to_legacy(zip_path, legacy_zip)
    with zipfile.ZipFile(legacy_zip) as zf:
        assert any(f"task-@{parent.id}/" in n for n in zf.namelist()), "forge failed"

    await unpack_bundle(legacy_zip, "local-user-id")

    # The staged MessageAttachment is keyed by the CANONICAL entry_key regardless
    # of the incoming legacy arc — so install can locate it.
    canonical_key = record_stem("task", parent.id)
    ma = await MessageAttachment.get_one(
        {"id": MessageAttachment.allocate_deterministic_id(fm.id, canonical_key)}
    )
    assert ma is not None, "legacy -@ bundle did not stage under the canonical key"

    from flow_sdk.app.actions.message_attachment_action import handle_attachment_install
    from flow_sdk.responses.response import ApiSuccessResponse

    receiver = env / "receiver"
    receiver.mkdir()
    project = Project(name="dst", fs_storage_mount_path=str(receiver))
    await project.save(notify=False)
    res = await handle_attachment_install(ma.id, "project", project.id)
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    r_task = receiver / AGENTIC_ASSETS_DIR / "task"
    assert any((p / "task.md").is_file() for p in r_task.iterdir()), "legacy bundle did not install on disk"


# ── the migration ───────────────────────────────────────────────────────────
def _load_migration():
    path = (
        "flow_sdk/system_projects/flowpad_assistant/migrations/0.2.103/scripts/migrate.py"
    )
    spec = importlib.util.spec_from_file_location("_stem_migration_0_2_103", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_migration_renames_legacy_shadows_and_staging(tmp_path):
    m = _load_migration()
    records = tmp_path / "records"
    data = tmp_path / "records_data"

    # A metadata-only shadow (does NOT regenerate) in the legacy shape.
    legacy_shadow = records / "app_secret" / "app_secret-@1111-2222-3333"
    legacy_shadow.mkdir(parents=True)
    (legacy_shadow / "metadata.json").write_text('{"id": "1111-2222-3333", "type": "app_secret"}')

    # A nested staging arc under a flow_message data dir (also legacy).
    arc = data / "flow_message" / "flow_message-@fm9" / "unpacked" / "attachment" / "spec-@s7"
    arc.mkdir(parents=True)
    (arc / "spec.md").write_text("x")

    counts = {"shadow_dirs": 0, "staging_arcs": 0, "ma_rows": 0}
    m._rename_top_level_to_bare(records, counts, dry_run=False)
    m._rename_top_level_to_bare(data, counts, dry_run=False)
    m._rename_staging_arcs_to_canonical(data, counts, dry_run=False)

    # Shadow → bare id; the legacy folder is gone.
    assert (records / "app_secret" / "1111-2222-3333" / "metadata.json").exists()
    assert not legacy_shadow.exists()
    # flow_message data dir → bare id; nested arc → canonical <type>-<id>.
    assert (data / "flow_message" / "fm9" / "unpacked" / "attachment" / "spec-s7" / "spec.md").exists()
    assert counts["shadow_dirs"] == 2 and counts["staging_arcs"] == 1


def test_migration_rewrites_message_attachment_rows(tmp_path):
    m = _load_migration()
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    db = tmp_path / "t.db"
    conn = open_sqlite(db)
    conn.execute("CREATE TABLE entities (id TEXT, type TEXT, data TEXT)")
    conn.execute(
        "INSERT INTO entities (id, type, data) VALUES (?, 'message_attachment', ?)",
        ("ma1", json.dumps({
            "id": "ma1",
            "entry_key": "spec-@s7",
            "unpacked_path": "unpacked/attachment/spec-@s7",
        })),
    )
    conn.commit()

    counts = {"shadow_dirs": 0, "staging_arcs": 0, "ma_rows": 0}
    m._rewrite_message_attachment_rows(conn, counts, dry_run=False)
    conn.commit()

    row = conn.execute("SELECT data FROM entities WHERE id = 'ma1'").fetchone()
    data = json.loads(row[0])
    conn.close()
    assert data["entry_key"] == "spec-s7"
    assert data["unpacked_path"] == "unpacked/attachment/spec-s7"
    assert counts["ma_rows"] == 1
