"""End-to-end test: AgenticProcess embedded_assets resolves real agent + skill
records (by uuid id, as the UI sends them), materializes files under
<record_dir>/assets/.claude/<type>/..., and tracks additional_dirs idempotently.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store.record import (
    get_default_records_root,
    get_default_records_data_root,
    set_default_records_root,
    set_default_records_data_root,
)


@pytest.fixture(autouse=True)
def isolate_records(tmp_path, monkeypatch):
    """Redirect records root + home for isolated agent/skill discovery."""
    orig_root = get_default_records_root()
    orig_data = get_default_records_data_root()
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    set_default_records_root(tmp_path / "records")
    set_default_records_data_root(tmp_path / "records")
    monkeypatch.setenv("HOME", str(fake_home))
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data)


def _make_agent_md(root: Path, name: str) -> Path:
    agents_dir = root / ".claude" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    md = agents_dir / f"{name}.md"
    md.write_text(
        "---\n"
        f"name: {name}\n"
        "description: long-test agent\n"
        "---\n\n"
        "You are a long-test agent.\n",
        encoding="utf-8",
    )
    return md


def _uid_for_path(p: Path) -> str:
    """Deterministic uuid5 from the absolute path — matches indexer convention."""
    return str(uuid5(NAMESPACE_URL, str(p.resolve())))


def _make_skill_dir(root: Path, name: str) -> Path:
    skills_dir = root / ".claude" / "skills"
    (skills_dir / name).mkdir(parents=True, exist_ok=True)
    skill_md = skills_dir / name / "SKILL.md"
    skill_md.write_text(
        "---\n"
        f"name: {name}\n"
        "description: long-test skill\n"
        "---\n\n"
        "Use me to do the long-test thing.\n",
        encoding="utf-8",
    )
    return skills_dir / name


@pytest.mark.asyncio
async def test_attach_agent_by_id_materializes_and_updates_add_dirs(isolate_records):
    """Attach a real agent by its uuid id. Backend must resolve via discover_one."""
    # Point agent discovery at our tmp home dir so load_agent finds it there too.
    agent_md = _make_agent_md(isolate_records / "home", "my-long-test-agent")
    agent_uid = _uid_for_path(agent_md)
    agent_ref = f"agent-{agent_uid}"

    # Stub AgentRecord.discover_one to return the fixture regardless of uid.
    import shutil as _sh
    from flow_sdk.fs_store.fs_ref import FSRef, FrontMatterFsRef
    fixture = AgentRecord.from_file(agent_md)
    fixture.id = agent_uid
    monkeypatch_target = AgentRecord  # noqa: F841 — readable

    orig_discover = AgentRecord.discover_one
    AgentRecord.discover_one = classmethod(lambda cls, uid, **kw: fixture if uid == agent_uid else orig_discover.__func__(cls, uid, **kw))
    try:
        proc = AgenticProcess(id=str(uuid.uuid4()))
        resp = await proc.attach_embedded_asset(entity_ref=agent_ref)

        assert resp.status == "SUCCESS", f"Expected SUCCESS, got: {resp}"
        assert [str(r) for r in proc.embedded_asset_refs] == [agent_ref]

        assets_dir = await proc._assets_dir_path()
        materialized = assets_dir / ".claude" / "agents" / "my-long-test-agent.md"
        assert materialized.is_file(), f"Expected materialized file at {materialized}"

        assert str(assets_dir) in proc.additional_dirs
        # Idempotent on second attach
        await proc.attach_embedded_asset(entity_ref=agent_ref)
        assert [str(r) for r in proc.embedded_asset_refs] == [agent_ref]
        assert proc.additional_dirs.count(str(assets_dir)) == 1
    finally:
        AgentRecord.discover_one = orig_discover


@pytest.mark.asyncio
async def test_attach_skill_by_id_copies_whole_folder(isolate_records):
    """Attach a skill — SkillRecord.copy_to copies the whole skill folder."""
    skill_folder = _make_skill_dir(isolate_records / "home", "my-long-test-skill")
    skill_uid = _uid_for_path(skill_folder)
    skill_ref = f"skill-{skill_uid}"

    fixture = SkillRecord.load_record(skill_folder)
    fixture.id = skill_uid

    orig_discover = SkillRecord.discover_one
    SkillRecord.discover_one = classmethod(lambda cls, uid, **kw: fixture if uid == skill_uid else orig_discover.__func__(cls, uid, **kw))
    try:
        proc = AgenticProcess(id=str(uuid.uuid4()))
        resp = await proc.attach_embedded_asset(entity_ref=skill_ref)

        assert resp.status == "SUCCESS", f"Expected SUCCESS, got: {resp}"
        assert [str(r) for r in proc.embedded_asset_refs] == [skill_ref]

        assets_dir = await proc._assets_dir_path()
        skill_target_md = assets_dir / ".claude" / "skills" / "my-long-test-skill" / "SKILL.md"
        assert skill_target_md.is_file(), f"Expected SKILL.md at {skill_target_md}"
    finally:
        SkillRecord.discover_one = orig_discover


@pytest.mark.asyncio
async def test_detach_removes_file_and_ref(isolate_records):
    agent_md = _make_agent_md(isolate_records / "home", "detach-test-agent")
    agent_uid = _uid_for_path(agent_md)
    agent_ref = f"agent-{agent_uid}"

    fixture = AgentRecord.from_file(agent_md)
    fixture.id = agent_uid

    orig_discover = AgentRecord.discover_one
    AgentRecord.discover_one = classmethod(lambda cls, uid, **kw: fixture if uid == agent_uid else orig_discover.__func__(cls, uid, **kw))
    try:
        proc = AgenticProcess(id=str(uuid.uuid4()))
        await proc.attach_embedded_asset(entity_ref=agent_ref)

        assets_dir = await proc._assets_dir_path()
        materialized = assets_dir / ".claude" / "agents" / "detach-test-agent.md"
        assert materialized.exists()

        resp = await proc.detach_embedded_asset(entity_ref=agent_ref)
        assert resp.status == "SUCCESS"
        assert agent_ref not in [str(r) for r in proc.embedded_asset_refs]
        assert not materialized.exists(), "Detach should remove materialized file"
    finally:
        AgentRecord.discover_one = orig_discover


@pytest.mark.asyncio
async def test_list_returns_refs(isolate_records):
    agent_md = _make_agent_md(isolate_records / "home", "list-test-agent")
    agent_uid = _uid_for_path(agent_md)
    agent_ref = f"agent-{agent_uid}"

    fixture = AgentRecord.from_file(agent_md)
    fixture.id = agent_uid

    orig_discover = AgentRecord.discover_one
    AgentRecord.discover_one = classmethod(lambda cls, uid, **kw: fixture if uid == agent_uid else orig_discover.__func__(cls, uid, **kw))
    try:
        proc = AgenticProcess(id=str(uuid.uuid4()))
        await proc.attach_embedded_asset(entity_ref=agent_ref)

        resp = await proc.list_embedded_assets()
        assert resp.data == {"refs": [agent_ref]}
    finally:
        AgentRecord.discover_one = orig_discover
