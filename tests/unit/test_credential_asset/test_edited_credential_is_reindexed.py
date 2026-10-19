"""An edited project ``credential.json`` is what its row says after the next index.

Found live on gsel-1 (2026-10-15): a project's ``gmail`` credential.json was replaced on disk with a newer
shape (its variables regrouped into ways). The backend kept serving the old variables across a restart, so
choosing the new way was refused ("not one of gmail's ways") until the file was reindexed by hand
(``reindex_paths``). Not fixed yet — this pins the expectation.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from flow_sdk.builtin.credential import Credential
from flow_sdk.builtin.credential_service import declare_credential
from flow_sdk.builtin.project import Project
from flow_sdk.instance_settings import get_instance_settings
from tests.unit.test_credential_asset.test_credential_reindex_keeps_project import _fresh_indexer, _index  # noqa: F401

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

BEFORE = {"schema": 2, "name": "mailbox", "setup": "…",
          "vars": {"ADDRESS": {"secret": False}, "PASSWORD": {"required": "ONE_OF"}, "TOKEN": {"required": "ONE_OF"}}}
AFTER = {**BEFORE, "vars": {"ADDRESS": {"required": "ONE_OF", "way": "pair", "secret": False},
                            "PASSWORD": {"required": "ONE_OF", "way": "pair"}, "TOKEN": {"required": "ONE_OF"}}}


@pytest.fixture
async def declared(folder_db):
    root = Path(get_instance_settings().user_home) / "Flowpad workspaces" / f"cred-{time.time_ns()}" / "shop"
    root.mkdir(parents=True)
    project = Project(name="shop", fs_storage_mount_path=str(root))
    await project.save()
    await declare_credential(BEFORE, project_id=str(project.id))
    return project, root / "agentic-assets" / "credential" / "mailbox"


async def test_a_credential_json_replaced_on_disk_is_read_again_by_the_project_index(declared):
    project, folder = declared
    time.sleep(0.01)
    (folder / "credential.json").write_text(json.dumps(AFTER, indent=2))  # a plain overwrite, as `cp` does

    await _index(Path(project.fs_storage_mount_path))

    row = await Credential.get("mailbox", project)
    assert row.vars["ADDRESS"].way == "pair" and row.is_way("pair"), "the row still holds the old variables"


@pytest.mark.xfail(strict=True, reason="OPEN (2026-10-15): a project is auto-indexed once (its marker), and nothing "
                   "re-reads an asset file edited on disk after that — not a re-activation, not a restart")
async def test_a_credential_json_replaced_on_disk_is_read_again_when_the_project_is_opened_again(declared):
    from flow_sdk.fs_store.indexer.auto_index import maybe_auto_index, write_auto_index_marker

    project, folder = declared
    write_auto_index_marker(str(project.id), int(time.time() * 1000))  # opened (and auto-indexed) before
    (folder / "credential.json").write_text(json.dumps(AFTER, indent=2))

    await maybe_auto_index(str(project.id), created=False)  # what opening the project again runs

    row = await Credential.get("mailbox", project)
    assert row.vars["ADDRESS"].way == "pair", "the row still holds the old variables"
