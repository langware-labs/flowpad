"""The identity migration reads the RETIRED forms through the live carrier.

Two ways a private reader drifts from the carrier it is converting FOR:

* validation — the live ``Sidecar`` refuses a capsule that is not version 1
  with exactly the ``id`` key, so a corrupt one must be reported, never
  silently adopted as an asset's identity;
* precedence — a source carrying two retired forms has ONE answer, and it is
  whichever the carrier's own read named. Two orders means two ids for one
  asset depending on which code looked.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.capsules import AssetCapsule, CapsuleData
from flow_sdk.capsules.folder import FolderCapsule
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import MalformedCarrier
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.migrations import migration_2026_09_identity_live_forms as mig

pytestmark = pytest.mark.timeout(30)

ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CAPSULE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def _capsule_file(folder: Path) -> Path:
    path = folder / ".flow" / "capsules" / "identity.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def test_a_corrupt_folder_capsule_is_refused_not_adopted(tmp_path: Path) -> None:
    """Extra keys beside ``id``: the live carrier calls that malformed, so the
    migration must too — a corrupt capsule is a reported issue, not an id."""
    _capsule_file(tmp_path).write_text(
        json.dumps({"version": 1, "data": {"id": CAPSULE_ID, "owner": "someone"}}), encoding="utf-8"
    )

    with pytest.raises(MalformedCarrier):
        mig._folder_json_id(tmp_path)


def test_a_wrong_version_folder_capsule_is_refused(tmp_path: Path) -> None:
    _capsule_file(tmp_path).write_text(
        json.dumps({"version": 2, "data": {"id": CAPSULE_ID}}), encoding="utf-8"
    )

    with pytest.raises(MalformedCarrier):
        mig._folder_json_id(tmp_path)


def test_a_valid_folder_capsule_still_reads(tmp_path: Path) -> None:
    FolderCapsule(tmp_path).write_if_absent("identity", CapsuleData(version=1, data={"id": CAPSULE_ID}))
    assert mig._folder_json_id(tmp_path) == CAPSULE_ID


def test_retired_form_precedence_is_the_carriers(tmp_path: Path) -> None:
    """A document carrying BOTH ``asset_id:`` and the retired comment capsule.
    ``Frontmatter.read`` names ``asset_id`` — so that is the id that moves, and
    the migration does not re-decide the order for itself."""
    doc = tmp_path / "notes.md"
    doc.write_text(f"---\nasset_id: {ASSET_ID}\n---\n\n# notes\n", encoding="utf-8")
    AssetCapsule.from_path(doc).write_if_absent("identity", CapsuleData(version=1, data={"id": CAPSULE_ID}))

    info = SchemaRegistry.get("markdown")
    assert mig._retired_read(info, FSRef(doc)) == ("frontmatter_asset_id", ASSET_ID)

    mig._convert(info, FSRef(doc), "frontmatter_asset_id", ASSET_ID)

    text = doc.read_text(encoding="utf-8")
    assert f"id: {ASSET_ID}" in text and "asset_id:" not in text
    assert CAPSULE_ID not in text
    assert mig._retired_read(info, FSRef(doc)) is None
