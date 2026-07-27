"""HTTP coverage for ``GET /api/v1/assets/entity?path=`` — the vfs-path → entity
(typeid) resolver the asset loader uses.

Drives the real FastAPI app via `bootstrapped_client`. A skill (folder-layout)
and an agent (file-layout) are written to disk in an arbitrary temp path and
indexed through the real indexer; then the endpoint must resolve each canonical
``asset_ref`` back to the same entity (correct type + id + scope), for user-space
and project-space. No mocks.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.asyncio

PROJECT_ID = "65daac3b-f3e4-5b1a-af77-6d1451ec5bc4"


def _v5(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, name))


def _write_skill(root: Path, name: str, sid: str) -> Path:
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nid: {sid}\nname: {name}\ndescription: a test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return folder


def _write_agent(root: Path, name: str, aid: str) -> Path:
    agents = root / ".claude" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    md = agents / f"{name}.md"
    md.write_text(
        f"---\nid: {aid}\nname: {name}\ndescription: a test agent\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return md


async def _index(root: Path, scope: str, project_id: str | None = None) -> None:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope=scope, project_id=project_id))
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn, RecordType.AGENT)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.SKILL, RecordType.AGENT]))


async def _resolve(client, path: str):
    resp = await client.get("/api/v1/assets/entity", params={"path": path})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.mark.parametrize("scope,pid", [("user", None), ("project", PROJECT_ID)])
async def test_skill_folder_resolves_via_endpoint(bootstrapped_client, tmp_path: Path, scope, pid):
    sid = _v5(f"api:skill:{scope}")
    folder = _write_skill(tmp_path, "api_skill", sid)
    await _index(tmp_path, scope, pid)

    data = await _resolve(bootstrapped_client, str(folder.resolve()))
    assert data is not None, "endpoint did not resolve the skill folder path"
    assert data["type"] == str(RecordType.SKILL)
    assert data["id"] == sid
    assert data["scope"] == scope
    if pid:
        assert data["project_id"] == pid


@pytest.mark.parametrize("scope,pid", [("user", None), ("project", PROJECT_ID)])
async def test_agent_file_resolves_via_endpoint(bootstrapped_client, tmp_path: Path, scope, pid):
    aid = _v5(f"api:agent:{scope}")
    md = _write_agent(tmp_path, "api_agent", aid)
    await _index(tmp_path, scope, pid)

    data = await _resolve(bootstrapped_client, str(md.resolve()))
    assert data is not None, "endpoint did not resolve the agent file path"
    assert data["type"] == str(RecordType.AGENT)
    assert data["id"] == aid
    assert data["scope"] == scope
    if pid:
        assert data["project_id"] == pid


async def test_skill_inner_file_resolves_to_skill(bootstrapped_client, tmp_path: Path):
    """Folder-layout inner file (SKILL.md) resolves to the owning Skill entity
    via the containing-folder fallback (exact miss → deepest ancestor
    ``asset_ref`` of a folder-layout type)."""
    sid = _v5("api:skill:inner")
    folder = _write_skill(tmp_path, "api_inner_skill", sid)
    await _index(tmp_path, "user")

    assert (await _resolve(bootstrapped_client, str(folder.resolve()))) is not None
    data = await _resolve(bootstrapped_client, str((folder / "SKILL.md").resolve()))
    assert data is not None, "inner SKILL.md did not resolve to the owning skill"
    assert data["type"] == str(RecordType.SKILL)
    assert data["id"] == sid


async def test_skill_nested_inner_file_resolves_to_skill(bootstrapped_client, tmp_path: Path):
    """A file nested deeper inside the skill folder still resolves to the Skill."""
    sid = _v5("api:skill:nested")
    folder = _write_skill(tmp_path, "api_nested_skill", sid)
    helpers = folder / "helpers"
    helpers.mkdir()
    inner = helpers / "x.py"
    inner.write_text("print('hi')\n", encoding="utf-8")
    await _index(tmp_path, "user")

    data = await _resolve(bootstrapped_client, str(inner.resolve()))
    assert data is not None, "nested inner file did not resolve to the owning skill"
    assert data["type"] == str(RecordType.SKILL)
    assert data["id"] == sid


async def test_exact_match_wins_over_containing_folder(bootstrapped_client, tmp_path: Path):
    """A file that is itself an indexed entity resolves to itself, not to a
    folder-backed ancestor: an agent .md placed INSIDE a skill folder must
    come back as the AGENT, exact match beating containment."""
    sid = _v5("api:skill:host")
    folder = _write_skill(tmp_path, "api_host_skill", sid)
    aid = _v5("api:agent:inside")
    inner_agents = folder / ".claude" / "agents"
    inner_agents.mkdir(parents=True)
    md = inner_agents / "inside_agent.md"
    md.write_text(
        f"---\nid: {aid}\nname: inside_agent\ndescription: nested agent\n---\n\n# inside\n",
        encoding="utf-8",
    )
    await _index(tmp_path, "user")
    # Index the agent under the skill folder too (agent_fn scans .claude/agents
    # under the root; the skill folder acts as a second root for this case).
    await _index(folder, "user")

    data = await _resolve(bootstrapped_client, str(md.resolve()))
    assert data is not None
    assert data["type"] == str(RecordType.AGENT), "exact match must beat containment"
    assert data["id"] == aid


async def test_unowned_path_returns_null(bootstrapped_client, tmp_path: Path):
    """A path under no indexed entity (and no folder-backed ancestor) is null."""
    stray = tmp_path / "stray" / "nothing.md"
    stray.parent.mkdir(parents=True)
    stray.write_text("# stray\n", encoding="utf-8")

    assert (await _resolve(bootstrapped_client, str(stray.resolve()))) is None
