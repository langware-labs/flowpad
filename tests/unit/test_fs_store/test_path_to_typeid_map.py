"""vfs-path → entity-typeid resolution (the map the asset URLs rely on).

Proves the core mapping `Entity.get_by_asset_ref(path) -> entity`: create a real
skill / agent on disk in an arbitrary path, run the real indexer, and confirm the
stored ``asset_ref`` resolves back to the SAME entity (correct type + id + scope)
— for both user-space and project-space.

Granularity matters and is asserted explicitly:
  * SKILL is folder-layout → its ``asset_ref`` is the FOLDER. The folder path
    resolves; the inner ``SKILL.md`` does NOT (exact-match only — no descendant
    ownership lookup). This is the gap a typeid/vfs deep-link to an inner file hits.
  * AGENT is file-layout → its ``asset_ref`` IS the ``.md`` file, so the file path
    (root == underlying file) resolves.

No mocks: real files, real indexer (`FSIndexer.index`), real SQLite via the
session DB fixture.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType

pytestmark = pytest.mark.asyncio

PROJECT_ID = "65daac3b-f3e4-5b1a-af77-6d1451ec5bc4"


def _v5(name: str) -> str:
    """A valid v5 entity id (so it is adopted from frontmatter, not re-minted)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, name))


def _write_skill(root: Path, name: str, sid: str) -> Path:
    """Folder-layout skill: `<root>/.claude/skills/<name>/SKILL.md`. Returns the folder."""
    folder = root / ".claude" / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nid: {sid}\nname: {name}\ndescription: a test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return folder


def _write_agent(root: Path, name: str, aid: str) -> Path:
    """File-layout agent: `<root>/.claude/agents/<name>.md`. Returns the file."""
    agents = root / ".claude" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    md = agents / f"{name}.md"
    md.write_text(
        f"---\nid: {aid}\nname: {name}\ndescription: a test agent\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return md


async def _index(root: Path, scope: str, project_id: str | None = None):
    """Index skills+agents under `root`, with the given scope stamped on the root."""
    drv = get_db_driver()
    await drv.delete_entities_by_type(str(RecordType.SKILL))
    await drv.delete_entities_by_type(str(RecordType.AGENT))
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope=scope, project_id=project_id))
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn, RecordType.SKILL)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn, RecordType.AGENT)
    return await idx.index(IndexerOptions(verbose=False, types=[RecordType.SKILL, RecordType.AGENT]))


@pytest.mark.parametrize("scope,pid", [("user", None), ("project", PROJECT_ID)])
async def test_skill_folder_path_resolves_to_typeid(tmp_path: Path, initialize_test_db, scope, pid):
    sid = _v5(f"skill:{scope}:demo")
    folder = _write_skill(tmp_path, "demo_skill", sid)

    res = await _index(tmp_path, scope, pid)
    assert res.per_type[RecordType.SKILL].indexed == 1

    e = await Entity.get_by_asset_ref(str(folder.resolve()))
    assert e is not None, "skill folder path did not map to any entity"
    assert e.get_type() == str(RecordType.SKILL)
    assert e.id == sid
    assert e.scope == scope
    if pid:
        assert e.project_id == pid


@pytest.mark.parametrize("scope,pid", [("user", None), ("project", PROJECT_ID)])
async def test_agent_file_path_resolves_to_typeid(tmp_path: Path, initialize_test_db, scope, pid):
    aid = _v5(f"agent:{scope}:demo")
    md = _write_agent(tmp_path, "demo_agent", aid)

    res = await _index(tmp_path, scope, pid)
    assert res.per_type[RecordType.AGENT].indexed == 1

    e = await Entity.get_by_asset_ref(str(md.resolve()))
    assert e is not None, "agent file path did not map to any entity"
    assert e.get_type() == str(RecordType.AGENT)
    assert e.id == aid
    assert e.scope == scope
    if pid:
        assert e.project_id == pid


async def test_skill_inner_file_path_is_not_mapped(tmp_path: Path, initialize_test_db):
    """The skill's `asset_ref` is the FOLDER; its inner `SKILL.md` does not map.

    This is exactly the gap an editor deep-link to an inner file would hit:
    `get_by_asset_ref` is exact-match, with no folder-descendant ownership lookup.
    """
    sid = _v5("skill:user:inner")
    folder = _write_skill(tmp_path, "inner_skill", sid)
    await _index(tmp_path, "user")

    # The folder (the canonical asset_ref) resolves...
    assert (await Entity.get_by_asset_ref(str(folder.resolve()))) is not None
    # ...but the underlying SKILL.md file does NOT resolve to the owning skill.
    inner = folder / "SKILL.md"
    assert (await Entity.get_by_asset_ref(str(inner.resolve()))) is None
