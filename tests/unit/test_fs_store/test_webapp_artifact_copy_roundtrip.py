"""Copy-mode webapp Artifact carrier: pack source bytes + clean declaration,
then restore with a receiver-local origin — no git and no runtime fields.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401
from flow_sdk.schema.type_info import register_all
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.local_origin import LocalOrigin
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
        id=mint_uuid(),
        name="spora",
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
