"""``GET /graph/project/<id>/published`` — the Discover read model: manifest
rows joined with local state, plus what the project could still publish."""
from __future__ import annotations

import json
import os
import uuid

import pytest

from flow_sdk.assets.project_manifest import make_entry, manifest_path, publish
from flow_sdk.fs_store.record_types import RecordType
from tests.api._published import MANIFEST, entity_row, index, project, toggle, write_skill

pytestmark = pytest.mark.asyncio


async def _view(client, pid: str) -> dict:
    resp = await client.get(f"/api/v1/graph/project/{pid}/published")
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_no_manifest_is_an_empty_but_well_formed_view(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)
    write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    view = await _view(bootstrapped_client, pid)
    assert view["manifest"] == {
        "exists": False, "schema": None, "requires": {}, "rel_path": str(MANIFEST), "typeid": None,
    }
    assert view["rows"] == []
    assert [u["name"] for u in view["unpublished"]] == ["rca"], "everything publishable is offered"


async def test_states_in_use_stale_install_missing(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)
    folder = write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    skill = await entity_row(bootstrapped_client, "skill", pid, "rca")
    assert (await toggle(bootstrapped_client, "skill", skill["id"], True)).status_code == 200

    view = await _view(bootstrapped_client, pid)
    assert view["manifest"]["exists"] and view["manifest"]["typeid"].startswith("project_manifest-")
    (row,) = view["rows"]
    assert (row["typeid"], row["state"], row["indexed"]) == (f"skill-{skill['id']}", "in_use", True)
    assert row["posix_path"] == str(folder)
    assert all(u["typeid"] != row["typeid"] for u in view["unpublished"]), "a published row is not offered again"

    # stale: the carrier is newer than the row's published_at.
    main = folder / "SKILL.md"
    future = main.stat().st_mtime + 60
    os.utime(main, (future, future))
    assert (await _view(bootstrapped_client, pid))["rows"][0]["state"] == "stale"

    # install: on disk, no local row (as after a git pull, before indexing).
    ghost_id = str(uuid.uuid4())
    write_skill(tmp_path, "ghost")
    publish(tmp_path, make_entry(typeid=f"skill-{ghost_id}", rel_path=".claude/skills/ghost", name="ghost"))
    states = {r["typeid"]: r["state"] for r in (await _view(bootstrapped_client, pid))["rows"]}
    assert states[f"skill-{ghost_id}"] == "install"

    # missing: named by the file, gone from disk.
    gone_id = str(uuid.uuid4())
    publish(tmp_path, make_entry(typeid=f"markdown-{gone_id}", rel_path="docs/gone.md", name="gone"))
    states = {r["typeid"]: r["state"] for r in (await _view(bootstrapped_client, pid))["rows"]}
    assert states[f"markdown-{gone_id}"] == "missing"

    # unpublish by typeid clears a row that has no entity to toggle.
    resp = await bootstrapped_client.post(f"/api/v1/graph/project/{pid}/unpublish", json={"typeid": f"markdown-{gone_id}"})
    assert resp.status_code == 200, resp.text
    assert f"markdown-{gone_id}" not in resp.json()["data"]["typeids"]
    assert f"markdown-{gone_id}" not in {e["typeid"] for e in json.loads(manifest_path(tmp_path).read_text())["entries"]}


async def test_unpublished_offers_project_assets_not_user_home_ones(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)
    write_skill(tmp_path, "inside")
    await index(tmp_path, pid, RecordType.SKILL)
    view = await _view(bootstrapped_client, pid)
    names = {u["name"] for u in view["unpublished"]}
    assert "inside" in names
    assert all(u["posix_path"].startswith(str(tmp_path)) for u in view["unpublished"]), "only assets under the mount"
