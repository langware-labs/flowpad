"""Pack/unpack roundtrip for FS-rooted skill + agent attachments.

Unlike ``test_flow_message_roundtrip.py`` (which mocks entity ``get_one`` calls
to stay schema-free), this test uses the real DB driver from
``initialize_test_db`` and runs the real ``FSIndexer`` against a tmp ``.claude/``
subtree. The surface under test is the bundle code's *generic* FS-rooted
branch — discovery, packing the literal subtree, and re-indexing after restore —
so a real indexer pass is the only honest way to pin it.

Test flow:
  1. Author a skill + agent under ``<src>/.claude/{skills,agents}/…``.
  2. Index → assert FS file, DB row, and FTS5 hit each exist for both.
  3. Pack a FlowMessage carrying both as ``TYPE_ID`` attachments.
  4. Tear down (rmtree + clear DB rows + clear FTS) → assert all three layers gone.
  5. Unpack into a fresh ``<dest>`` → assert FS subtree restored *and* indexer
     repopulated DB row + FTS5 hit.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.flow_message_bundle import pack_bundle, unpack_bundle
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType


_SKILL_NAME = "fizzy-wolf-skill"
_AGENT_NAME = "fizzy-wolf-agent"
_SKILL_DESCRIPTION = "fizzy wolf round-trip skill"
_AGENT_DESCRIPTION = "fizzy wolf round-trip agent"


def _build_indexer_for_assets(root: Path) -> FSIndexer:
    """Minimal indexer with skill_fn + agent_fn registered on USER_HOME_FOLDER."""
    idx = FSIndexer(
        roots=[FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn)
    return idx


def _write_skill(root: Path) -> Path:
    skill_dir = root / ".claude" / "skills" / _SKILL_NAME
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {_SKILL_NAME}\ndescription: {_SKILL_DESCRIPTION}\n---\nbody one",
        encoding="utf-8",
    )
    return skill_dir


def _write_agent(root: Path) -> Path:
    agent_path = root / ".claude" / "agents" / f"{_AGENT_NAME}.md"
    agent_path.parent.mkdir(parents=True, exist_ok=True)
    agent_path.write_text(
        f"---\nname: {_AGENT_NAME}\ndescription: {_AGENT_DESCRIPTION}\n---\nbody two",
        encoding="utf-8",
    )
    return agent_path


async def _fts_hits(query: str) -> list[str]:
    """Return entity ids whose FTS5 row matches ``query``. Empty on no hits.

    Uses the driver's ``fts_search`` which returns hydrated Entity objects.
    """
    driver = get_db_driver()
    rows = await driver.fts_search(query, limit=50)
    return [getattr(r, "id", None) for r in rows if getattr(r, "id", None)]


async def _clear_asset_state() -> None:
    """Wipe SKILL + AGENT DB rows + their on-disk shadow directories.

    The indexer's orphan detection only fires for types it actually scanned;
    after the test rmtrees the source tree, scan emits zero SKILL/AGENT refs
    and orphans go undetected. Cheaper and more direct: clear all three layers
    (DB row, FTS entry, shadow dir) ourselves.
    """
    import shutil as _shutil

    from flow_sdk.fs_store.record import get_default_records_root

    driver = get_db_driver()
    for rt in (RecordType.SKILL, RecordType.AGENT):
        await driver.delete_entities_by_type(str(rt))
        shadow_dir = get_default_records_root() / str(rt)
        if shadow_dir.exists():
            _shutil.rmtree(shadow_dir, ignore_errors=True)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_pack_unpack_skill_agent_roundtrip(tmp_path: Path) -> None:
    src_root = tmp_path / "src"

    # --- 1. Create skill + agent at the canonical .claude/* layout ---------
    skill_dir = _write_skill(src_root)
    agent_path = _write_agent(src_root)

    # --- 2. Index → assert FS, Record, FTS5 all present --------------------
    indexer = _build_indexer_for_assets(src_root)
    result = await indexer.index(IndexerOptions(verbose=False, force=True))

    # Ids match what Entity.allocate_id derives, since Record.sync_to_db routes
    # the raw record id through Entity.from_record before persisting. Skill's
    # raw id is already a uuid5(name); agent's raw id is the name string, which
    # allocate_id transforms to uuid5("agent:<name>").
    skill_id = SkillRecord.load_record(skill_dir).id
    agent_id = Entity.allocate_id({"id": _AGENT_NAME, "type": str(RecordType.AGENT)})

    driver = get_db_driver()
    skill_count = await driver.count_entities_by_type(str(RecordType.SKILL))
    agent_count = await driver.count_entities_by_type(str(RecordType.AGENT))
    assert skill_count >= 1, f"no SKILL entities after index; result={result.per_type}"
    assert agent_count >= 1, f"no AGENT entities after index; result={result.per_type}"

    skill_rec = SkillRecord.get(skill_id)
    agent_rec = AgentRecord.get(agent_id)
    assert skill_rec is not None, "indexer did not produce SkillRecord row"
    assert agent_rec is not None, f"indexer did not produce AgentRecord row (looked up id={agent_id})"

    skill_hits_pre = await _fts_hits(_SKILL_DESCRIPTION)
    agent_hits_pre = await _fts_hits(_AGENT_DESCRIPTION)
    assert skill_id in skill_hits_pre, f"skill missing from FTS: {skill_hits_pre}"
    assert agent_id in agent_hits_pre, f"agent missing from FTS: {agent_hits_pre}"

    # --- 3. FM with TYPE_ID attachments → pack -----------------------------
    fm = FlowMessage(text="fizzy wolf", attachment=[])
    fm.id = "aaaa1111-0000-0000-0000-000000000099"
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{skill_id}"),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"agent-{agent_id}"),
    ]
    zip_path = await pack_bundle(fm, dest_dir=tmp_path / "out")

    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
    expected_skill_path = (
        f"attachment/skill-@{skill_id}/.claude/skills/{_SKILL_NAME}/SKILL.md"
    )
    expected_agent_path = (
        f"attachment/agent-@{agent_id}/.claude/agents/{_AGENT_NAME}.md"
    )
    assert expected_skill_path in names, f"skill not in bundle. names={sorted(names)}"
    assert expected_agent_path in names, f"agent not in bundle. names={sorted(names)}"

    # --- 4. Tear down — delete FS + clear DB rows → assert gone -----------
    import shutil as _shutil
    _shutil.rmtree(src_root / ".claude")
    await _clear_asset_state()

    assert not skill_dir.exists()
    assert not agent_path.exists()
    assert SkillRecord.get(skill_id) is None
    assert AgentRecord.get(agent_id) is None
    assert skill_id not in await _fts_hits(_SKILL_DESCRIPTION)
    assert agent_id not in await _fts_hits(_AGENT_DESCRIPTION)

    # --- 5. Unpack into a fresh dest_root → FS + Record + FTS all restored
    dest_root = tmp_path / "dest"
    dest_root.mkdir()
    await unpack_bundle(
        zip_path,
        local_user_id="local",
        overwrite=False,
        asset_dest_root=dest_root,
    )

    restored_skill = dest_root / ".claude" / "skills" / _SKILL_NAME / "SKILL.md"
    restored_agent = dest_root / ".claude" / "agents" / f"{_AGENT_NAME}.md"
    assert restored_skill.exists(), "skill FS subtree not restored"
    assert restored_agent.exists(), "agent FS file not restored"

    # Ids are deterministic (uuid5(name) for skill, name for agent) so the
    # post-unpack lookups match the originals.
    assert SkillRecord.get(skill_id) is not None, "skill not reindexed after unpack"
    assert AgentRecord.get(agent_id) is not None, "agent not reindexed after unpack"
    assert skill_id in await _fts_hits(_SKILL_DESCRIPTION)
    assert agent_id in await _fts_hits(_AGENT_DESCRIPTION)
