"""``remove_asset_files`` deletes a removed asset's own files — and never one that ships with the SDK."""
from __future__ import annotations

from pathlib import Path

import pytest

import flow_sdk.config as config
from flow_sdk.assets.folder import remove_asset_files
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SOURCE = EntityType.DATA_SOURCE.value


def _source_folder(under: Path) -> Path:
    folder = under / "agentic-assets" / "data_source" / "feed"
    folder.mkdir(parents=True)
    (folder / "data_source.json").write_text("{}", encoding="utf-8")
    return folder


def test_a_removed_assets_folder_goes(tmp_path: Path):
    folder = _source_folder(tmp_path / "project")

    remove_asset_files(SOURCE, str(folder))

    assert not folder.exists()


def test_a_folder_inside_the_shipped_system_project_stays(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    shipped = tmp_path / "install" / "system_project"
    folder = _source_folder(shipped)
    monkeypatch.setattr(config, "flowpad_assistant_project_root", lambda: shipped)

    remove_asset_files(SOURCE, str(folder))

    assert (folder / "data_source.json").is_file(), "an asset that ships with the SDK is never deleted"


def test_a_folder_that_is_not_the_assets_own_stays(tmp_path: Path):
    other = tmp_path / "project" / "notes"
    other.mkdir(parents=True)
    (other / "readme.md").write_text("x", encoding="utf-8")

    remove_asset_files(SOURCE, str(other))
    remove_asset_files(SOURCE, None)

    assert (other / "readme.md").is_file(), "only a folder holding the type's own main document is removed"
