"""Copy-mode webapp-artifact carrier (Knot A): pack the folder bytes + declaration,
then restore into a project pointing ``path`` at the served folder — no git, no clone.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401
from flow_sdk.schema.type_info import register_all
from flow_sdk.builtin.artifact import Artifact, ArtifactReferenceType, ArtifactType
from flow_sdk.builtin.flow_message_bundle import (
    _pack_webapp_artifact_attachment,
    _restore_webapp_artifact_entry,
    _TRANSFER_MODE_COPY,
    _entry_key,
)

register_all()


@pytest.mark.asyncio
async def test_copy_webapp_artifact_pack_then_restore(tmp_path: Path):
    # A spora-like static app folder (index.html, no package.json, no git).
    src = tmp_path / "spora-src"
    src.mkdir()
    (src / "index.html").write_text("<title>SPORA — Smart Home Simulator</title>", encoding="utf-8")
    (src / "app.jsx").write_text("// prototype", encoding="utf-8")

    art = Artifact(
        id=str(uuid.uuid4()),
        name="spora",
        artifact_type=ArtifactType.WEBAPP.value,
        ref_type=ArtifactReferenceType.FOLDER.value,
        path=str(src),
        port="8000",
        start_cmd="python3 -m http.server 8000",
        health="/",
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
    project_id = str(uuid.uuid4())
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
    assert row.path == str(served)                       # points at the served folder
    assert row.artifact_type == ArtifactType.WEBAPP.value
    assert str(row.port) == "8000"
    assert row.start_cmd == "python3 -m http.server 8000"
