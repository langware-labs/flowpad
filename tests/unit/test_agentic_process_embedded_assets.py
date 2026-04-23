"""Unit tests for AgenticProcess.embedded_assets (attach/detach/list).

Scopes:
- Plumbing: attach updates embedded_asset_refs + additional_dirs; detach reverses.
- Idempotency: attaching the same ref twice doesn't duplicate.
- Materialization is exercised end-to-end for agents (single .md file), and
  monkeypatched for skills (to keep the test hermetic — full skill discovery
  is a separate concern covered by skill_record tests).
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_store.record import (
    get_default_records_root,
    get_default_records_data_root,
    set_default_records_root,
    set_default_records_data_root,
)


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _proc() -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()))


def _write_agent_md(root: Path, name: str) -> Path:
    """Create a minimal .md file that AgentRecord.from_file can parse."""
    agents_dir = root / ".claude" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    md = agents_dir / f"{name}.md"
    md.write_text(
        "---\n"
        f"name: {name}\n"
        "description: test agent\n"
        "---\n\n"
        "You are a helpful test agent.\n",
        encoding="utf-8",
    )
    return md


# ──────────────────────────────────────────────────────────────────────────────
# Defaults
# ──────────────────────────────────────────────────────────────────────────────

def test_embedded_asset_refs_default_empty():
    proc = _proc()
    assert proc.embedded_asset_refs == []


# ──────────────────────────────────────────────────────────────────────────────
# Plumbing via monkeypatched materialize — verifies attach/detach book-keeping
# without depending on global agent/skill discovery.
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_attach_updates_refs_and_add_dirs(monkeypatch):
    proc = _proc()

    async def _fake_materialize(self, ref, assets_dir):
        (assets_dir / "touched").write_text("")
        return "fake-name"

    async def _fake_get_record(self):
        return None  # forces _assets_dir_path fallback path

    monkeypatch.setattr(AgenticProcess, "_materialize_entity", _fake_materialize)
    monkeypatch.setattr(AgenticProcess, "get_record", _fake_get_record)
    monkeypatch.setattr(AgenticProcess, "save", lambda self: _aio_noop())

    resp = await proc.attach_embedded_asset(entity_ref="agent-abc")
    assert resp.status == "SUCCESS"

    assert proc.embedded_asset_refs == ["agent-abc"]
    # additional_dirs gets the assets folder exactly once
    assets_entries = [d for d in proc.additional_dirs if d.endswith("/assets")]
    assert len(assets_entries) == 1


@pytest.mark.asyncio
async def test_attach_is_idempotent(monkeypatch):
    proc = _proc()

    async def _fake_materialize(self, ref, assets_dir):
        return "fake"

    async def _fake_get_record(self):
        return None

    monkeypatch.setattr(AgenticProcess, "_materialize_entity", _fake_materialize)
    monkeypatch.setattr(AgenticProcess, "get_record", _fake_get_record)
    monkeypatch.setattr(AgenticProcess, "save", lambda self: _aio_noop())

    await proc.attach_embedded_asset(entity_ref="agent-x")
    await proc.attach_embedded_asset(entity_ref="agent-x")
    assert proc.embedded_asset_refs == ["agent-x"]
    assert len([d for d in proc.additional_dirs if d.endswith("/assets")]) == 1


@pytest.mark.asyncio
async def test_detach_removes_ref_and_calls_unmaterialize(monkeypatch):
    proc = _proc()
    proc.embedded_asset_refs = ["agent-y", "agent-z"]

    captured: list[str] = []

    async def _fake_unmat(self, ref, assets_dir):
        captured.append(ref)

    async def _fake_get_record(self):
        return None

    monkeypatch.setattr(AgenticProcess, "_unmaterialize_entity", _fake_unmat)
    monkeypatch.setattr(AgenticProcess, "get_record", _fake_get_record)
    monkeypatch.setattr(AgenticProcess, "save", lambda self: _aio_noop())

    resp = await proc.detach_embedded_asset(entity_ref="agent-y")
    assert resp.status == "SUCCESS"
    assert proc.embedded_asset_refs == ["agent-z"]
    assert captured == ["agent-y"]


@pytest.mark.asyncio
async def test_list_returns_current_refs():
    proc = _proc()
    proc.embedded_asset_refs = ["agent-a", "skill-b"]
    resp = await proc.list_embedded_assets()
    assert resp.data == {"refs": ["agent-a", "skill-b"]}


# ──────────────────────────────────────────────────────────────────────────────
# End-to-end agent materialization — uses real AgentRecord on-disk fixture.
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_materialize_agent_copies_md_to_assets_claude_agents(tmp_path, monkeypatch):
    md = _write_agent_md(tmp_path, "helper-agent")

    async def _fake_load_agent(ent_id):
        return AgentRecord.from_file(md)

    # Point AgentRecord.load_agent at our fixture regardless of the id passed
    # (our helper's resolution path doesn't need the real uid scan here).
    monkeypatch.setattr(
        "flow_sdk.fs_records.agent_record.AgentRecord.load_agent",
        staticmethod(lambda ent_id, project_dir=None: AgentRecord.from_file(md)),
    )

    proc = _proc()
    assets_dir = tmp_path / "assets_target"
    assets_dir.mkdir()

    name = await proc._materialize_entity("agent-whatever", assets_dir)
    assert name == "helper-agent"
    assert (assets_dir / ".claude" / "agents" / "helper-agent.md").is_file()


async def _aio_noop():
    return None
