"""``POST /graph/<type>/<id>/set-published`` over HTTP, on a real project folder.

A publish stamps the asset's id into its own carrier, writes the row into
``agentic-assets/project_manifest/project_manifest.json`` and leaves the
manifest indexed with a sidecar id; an unpublish drops the row. Refusals are
400s with a ``code`` the toggle can show.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.llm_index.markdown_document import parse_frontmatter
from tests.api._published import MANIFEST, SIDECAR, entity_row, index, project, toggle, write_skill, write_subagent

pytestmark = pytest.mark.asyncio


async def test_publish_stamps_the_id_writes_the_row_and_unpublish_drops_it(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)
    folder = write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    skill = await entity_row(bootstrapped_client, "skill", pid, "rca")
    assert skill.get("published") is False
    # The indexer already stamped the carrier (writable-carrier policy); the
    # publish's own stamp is then "Found wins" — the ids must agree.

    resp = await toggle(bootstrapped_client, "skill", skill["id"], True)
    assert resp.status_code == 200, resp.text
    canonical = resp.json()["data"]
    assert canonical["id"] == skill["id"] and canonical["published"] is True

    assert parse_frontmatter((folder / "SKILL.md").read_text())[0]["id"] == skill["id"], "the row id IS the carrier id"
    doc = json.loads((tmp_path / MANIFEST).read_text())
    assert doc["schema"] == 1
    assert [e["typeid"] for e in doc["entries"]] == [f"skill-{skill['id']}"]
    assert doc["entries"][0]["rel_path"] == ".claude/skills/rca"
    sidecar = json.loads((tmp_path / SIDECAR).read_text())
    assert uuid.UUID(sidecar["data"]["id"]).version == 4, "the manifest has its own minted id"

    resp = await toggle(bootstrapped_client, "skill", skill["id"], False)
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["published"] is False
    assert json.loads((tmp_path / MANIFEST).read_text())["entries"] == []
    assert (await entity_row(bootstrapped_client, "skill", pid, "rca"))["published"] is False


async def test_publish_is_idempotent(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)
    write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    skill = await entity_row(bootstrapped_client, "skill", pid, "rca")
    for _ in range(2):
        resp = await toggle(bootstrapped_client, "skill", skill["id"], True)
        assert resp.status_code == 200, resp.text
    assert len(json.loads((tmp_path / MANIFEST).read_text())["entries"]) == 1


async def test_a_subagent_gets_only_an_id_in_its_provider_owned_frontmatter(bootstrapped_client, tmp_path):
    """``.claude/agents/*.md`` mirrors Claude Code's own format: the publish may
    add ``id:`` (the carrier policy) and nothing else — never ``published:``."""
    pid = await project(bootstrapped_client, tmp_path)
    md = write_subagent(tmp_path, "helper")
    await index(tmp_path, pid, RecordType.SUBAGENT)
    agent = await entity_row(bootstrapped_client, "subagent", pid, "helper")

    resp = await toggle(bootstrapped_client, "subagent", agent["id"], True)
    assert resp.status_code == 200, resp.text
    fm, _ = parse_frontmatter(md.read_text())
    assert fm["id"] == agent["id"]
    assert "published" not in fm
    assert set(fm) == {"id", "name", "description"}
    assert json.loads((tmp_path / MANIFEST).read_text())["entries"][0]["rel_path"] == ".claude/agents/helper.md"


async def test_refusals_are_400_with_a_code(bootstrapped_client, tmp_path):
    pid = await project(bootstrapped_client, tmp_path)

    # A type that is not publishable.
    resp = await bootstrapped_client.post(f"/api/v1/graph/project/{pid}/set-published", json={"published": True})
    assert resp.status_code == 400, resp.text
    assert resp.json()["data"]["code"] == "not_publishable"

    # An asset outside the project folder cannot be a manifest row.
    outside = tmp_path.parent / f"outside-{uuid.uuid4().hex[:6]}"
    write_skill(outside, "far")
    await index(outside, pid, RecordType.SKILL)
    far = await entity_row(bootstrapped_client, "skill", pid, "far")
    resp = await toggle(bootstrapped_client, "skill", far["id"], True)
    assert resp.status_code == 400, resp.text
    assert resp.json()["data"]["code"] == "outside_project"
    assert not (tmp_path / MANIFEST).exists(), "a refusal writes nothing"
