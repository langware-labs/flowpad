"""Copy-mode webapp Artifact carrier: pack source bytes + clean declaration,
then restore with a receiver-local origin — no git and no runtime fields.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.flow_message_bundle import (
    _TRANSFER_MODE_COPY,
    _entry_key,
    _pack_webapp_artifact_attachment,
    _restore_webapp_artifact_entry,
)
from flow_sdk.fs_store.origin.local_origin import LocalOrigin
from flow_sdk.schema.type_info import register_all

register_all()


@pytest.mark.asyncio
async def test_copy_webapp_artifact_pack_then_restore(tmp_path: Path):
    # A acme-like static app folder (index.html, no package.json, no git).
    src = tmp_path / "acme-src"
    src.mkdir()
    (src / "index.html").write_text("<title>ACME — Smart Home Simulator</title>", encoding="utf-8")
    (src / "app.jsx").write_text("// prototype", encoding="utf-8")

    art = Artifact(
        id=mint_uuid(),
        name="acme",
        kind="application.web",
        origin=LocalOrigin(base=str(src.parent), rel_path=src.name),
    )
    await art.save()
    key = _entry_key(art.get_type(), art.id)

    # --- Sender pack: bytes under attachment/<key>/webapps/<slug>/, declaration to metadata/ ---
    bundle = tmp_path / "bundle"
    attachment_dir = bundle / "attachment"
    attachment_dir.mkdir(parents=True)
    transfers: dict = {}
    handled = await _pack_webapp_artifact_attachment(
        art.get_type(), art.id, attachment_dir, transfers, _TRANSFER_MODE_COPY,
    )
    assert handled is True
    entry = transfers[key]
    assert entry["transfer_mode"] == _TRANSFER_MODE_COPY
    slug = entry["slug"]
    assert (attachment_dir / key / "webapps" / slug / "index.html").exists()
    assert (bundle / entry["metadata_path"]).exists()  # declaration rode separately

    # --- Receiver restore: mirror bytes into the project, materialize the row (fresh) ---
    # Drop the sender-side row so the restore materializes it (receiver has none).
    await art.destroy()
    assert await Artifact.get_one({"id": art.id}) is None

    project_root = tmp_path / "project"
    project_root.mkdir()
    project_id = mint_uuid()
    served = await _restore_webapp_artifact_entry(
        attachment_dir / key,
        project_root,
        entry,
        bundle,  # unpacked_root — metadata_path is relative to it
        asset_id=art.id,
        project_id=project_id,
        overwrite=False,
        owner_typeid=None,
    )
    assert served is not None
    assert (served / "index.html").exists()
    assert served == project_root / "webapps" / slug

    row = await Artifact.get_one({"id": art.id})
    assert row is not None
    assert row.kind == "application.web"
    assert row.origin.kind == "local"
    assert Path(row.origin.base) / row.origin.rel_path == served
    payload = row.model_dump(mode="json")
    assert "artifact_type" not in payload
    assert "port" not in payload


@pytest.mark.asyncio
async def test_copy_shared_file_artifact_ships_its_bytes(tmp_path: Path):
    # A file shared as itself (an image, a doc) travels as the artifact that
    # names it; as a copy it must carry the file, and open as the file.
    from flow_sdk.builtin.artifact import SHARED_FILE_KIND

    folder = tmp_path / "repo"
    folder.mkdir()
    (folder / "photo.png").write_bytes(b"\x89PNG-bytes")
    art = await Artifact.for_shared_file(str(folder / "photo.png"))
    assert art.kind == SHARED_FILE_KIND
    key = _entry_key(art.get_type(), art.id)

    bundle = tmp_path / "bundle"
    attachment_dir = bundle / "attachment"
    attachment_dir.mkdir(parents=True)
    transfers: dict = {}
    assert await _pack_webapp_artifact_attachment(art.get_type(), art.id, attachment_dir, transfers, _TRANSFER_MODE_COPY)
    entry = transfers[key]
    assert entry["single_file"] is True
    assert (attachment_dir / key / "shared" / art.id / "photo.png").read_bytes() == b"\x89PNG-bytes"

    await art.destroy()
    home = tmp_path / "recipient"
    home.mkdir()
    served = await _restore_webapp_artifact_entry(
        attachment_dir / key, home, entry, bundle,
        asset_id=art.id, project_id=None, overwrite=False, owner_typeid=None,
    )
    assert served == home / "shared" / art.id / "photo.png"
    assert served.read_bytes() == b"\x89PNG-bytes"
    row = await Artifact.get_one({"id": art.id})
    assert row is not None and row.kind == SHARED_FILE_KIND
    assert row.asset_ref == str(served)


@pytest.mark.asyncio
async def test_shared_file_belongs_to_the_project_that_holds_it(tmp_path: Path):
    # A file deep inside a plain (non-git) project folder is that project's —
    # it must not try to open its own folder as a nested project.
    from flow_sdk.builtin.project import Project

    root = tmp_path / "plain-project"
    (root / "site").mkdir(parents=True)
    (root / "site" / "index.html").write_text("<h1>hi</h1>", encoding="utf-8")
    project = Project(name="plain-project", fs_storage_mount_path=str(root))
    await project.save()
    art = await Artifact.for_shared_file(str(root / "site" / "index.html"))
    assert art.project_id == project.id
