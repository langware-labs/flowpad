"""``POST /graph/project/<id>/install-published`` — a published row from
project A lands in project B: copied at the type's placement, indexed with the
publisher's id, recorded in B's ``deps.json``."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.record_types import RecordType
from tests.api._published import entity_row, index, project, toggle, write_skill

pytestmark = pytest.mark.asyncio

DEPS = Path("agentic-assets/project_manifest/deps.json")


async def _publishedrow(client, pid: str, typeid: str) -> dict:
    resp = await client.get(f"/api/v1/graph/project/{pid}/published")
    assert resp.status_code == 200, resp.text
    (row,) = [r for r in resp.json()["data"]["rows"] if r["typeid"] == typeid]
    return row


async def _install(client, target: str, request: dict, **extra):
    return await client.post(f"/api/v1/graph/project/{target}/install-published", json={"request": request, **extra})


async def _publish_a_skill(client, tmp_path):
    a_root = tmp_path / "a"
    a_root.mkdir()
    a = await project(client, a_root)
    write_skill(a_root, "rca")
    await index(a_root, a, RecordType.SKILL)
    skill = await entity_row(client, "skill", a, "rca")
    assert (await toggle(client, "skill", skill["id"], True)).status_code == 200
    row = await _publishedrow(client, a, f"skill-{skill['id']}")
    assert row["origin"] and row["origin"]["kind"] == "local", "a git-less project publishes a local origin"
    return a, a_root, skill, row


async def test_install_copies_indexes_with_the_same_id_and_records_the_dependency(bootstrapped_client, tmp_path):
    a, a_root, skill, row = await _publish_a_skill(bootstrapped_client, tmp_path)
    b_root = tmp_path / "b"
    b_root.mkdir()
    b = await project(bootstrapped_client, b_root)

    request = {**row, "source_project_id": a, "source_project_name": "a"}
    resp = await _install(bootstrapped_client, b, request)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["id"] == skill["id"], "the copy keeps the publisher's id"
    # A skill declares a setup skill, so the reception hook may hand back the
    # Vibe session it spawned instead of the entity itself — either is a target.
    assert data["show"]["kind"] and data["show"]["typeid"].split("-", 1)[0] in {"skill", "agentic_process"}
    dest = Path(data["posix_path"])
    assert dest == b_root / ".claude" / "skills" / "rca" and (dest / "SKILL.md").exists()

    deps = json.loads((b_root / DEPS).read_text())
    (dep,) = deps["entries"]
    assert (dep["typeid"], dep["source_project_id"], dep["origin"]["kind"]) == (f"skill-{skill['id']}", a, "local")
    assert dep["installed_at"].endswith("Z")

    got = await bootstrapped_client.get(f"/api/v1/graph/skill/{skill['id']}")
    assert got.json()["data"]["project_id"] == b
    # A dependency is not something B published.
    view = (await bootstrapped_client.get(f"/api/v1/graph/project/{b}/published")).json()["data"]
    assert view["rows"] == []


async def test_second_install_refuses_unless_overwrite(bootstrapped_client, tmp_path):
    a, _a_root, _skill, row = await _publish_a_skill(bootstrapped_client, tmp_path)
    b_root = tmp_path / "b"
    b_root.mkdir()
    b = await project(bootstrapped_client, b_root)
    request = {**row, "source_project_id": a}
    assert (await _install(bootstrapped_client, b, request)).status_code == 200
    again = await _install(bootstrapped_client, b, request)
    assert again.status_code == 400 and again.json()["data"]["code"] == "exists"
    assert (await _install(bootstrapped_client, b, request, overwrite=True)).status_code == 200


async def test_refusals(bootstrapped_client, tmp_path):
    a, a_root, _skill, row = await _publish_a_skill(bootstrapped_client, tmp_path)
    b_root = tmp_path / "b"
    b_root.mkdir()
    b = await project(bootstrapped_client, b_root)
    no_origin = await _install(bootstrapped_client, b, {**{k: v for k, v in row.items() if k != "origin"}, "source_project_id": a})
    assert no_origin.status_code == 400 and no_origin.json()["data"]["code"] == "no_origin"
    gone = await _install(bootstrapped_client, b, {**row, "origin": {"kind": "local", "base": str(a_root / "nowhere"), "rel_path": "x"}, "source_project_id": a})
    assert gone.status_code == 400 and gone.json()["data"]["code"] == "missing"
    same = await _install(bootstrapped_client, a, {**row, "source_project_id": a})
    assert same.status_code == 400 and same.json()["data"]["code"] == "same_project"
