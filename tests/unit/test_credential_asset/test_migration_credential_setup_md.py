"""An authored credential's inline guide moves into ``setup.md`` — once, never over a file already there."""
from __future__ import annotations

import json

import pytest

from flow_sdk.migrations import migration_2026_09_credential_setup_md as migration

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


def _authored(tmp_path, name: str, **doc):
    folder = tmp_path / "agentic-assets" / "credential" / name
    folder.mkdir(parents=True)
    (folder / "credential.json").write_text(json.dumps({"name": name, "schema": 2, "vars": {}, **doc}))
    return folder


async def test_an_inline_guide_moves_into_setup_md_and_leaves_the_manifest(tmp_path):
    folder = _authored(tmp_path, "svc", setup="1. Open the console.\n2. Copy the key.")

    assert migration.move_one(folder, dry_run=True) is True
    assert "setup" in json.loads((folder / "credential.json").read_text()), "a dry run changes nothing"

    assert migration.move_one(folder, dry_run=False) is True
    assert (folder / "setup.md").read_text() == "1. Open the console.\n2. Copy the key.\n"
    assert json.loads((folder / "credential.json").read_text()) == {"name": "svc", "schema": 2, "vars": {}}
    assert migration.move_one(folder, dry_run=False) is False, "nothing left to move"


async def test_a_setup_md_already_there_is_never_overwritten(tmp_path):
    folder = _authored(tmp_path, "svc", setup="old inline")
    (folder / "setup.md").write_text("the edited guide\n")

    migration.move_one(folder, dry_run=False)

    assert (folder / "setup.md").read_text() == "the edited guide\n"
    assert "setup" not in json.loads((folder / "credential.json").read_text())
