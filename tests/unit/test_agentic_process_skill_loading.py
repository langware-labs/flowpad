"""Worker-aware skill loading: ``_skills_root`` routes per worker and
``load_skill`` resolves a Skill entity / record / path to its source folder.

Pure unit — no DB, no live worker (``load_embedded_skill_action`` is stubbed to
capture what ``load_skill`` forwards)."""

from __future__ import annotations

from pathlib import Path

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType


def _proc(worker_type: WorkerType) -> AgenticProcess:
    return AgenticProcess(worker_type=worker_type, workdir="/tmp/wd")


def test_skills_root_claude_and_copilot_use_mounted_claude_skills(monkeypatch):
    assets = Path("/tmp/assets")
    for wt in (WorkerType.CLAUDE_CODE, WorkerType.COPILOT):
        assert _proc(wt)._skills_root(assets) == assets / ".claude" / "skills"


def test_skills_root_codex_uses_codex_home(monkeypatch, tmp_path):
    class _Settings:
        codex_home = tmp_path / ".codex"

    monkeypatch.setattr(
        "flow_sdk.instance_settings.get_instance_settings", lambda: _Settings()
    )
    root = _proc(WorkerType.CODEX)._skills_root(Path("/tmp/assets"))
    assert root == tmp_path / ".codex" / "skills"


def _patch_action(monkeypatch, captured: dict) -> None:
    async def _fake(self, asset_ref: str = ""):
        captured["ref"] = asset_ref
        return None

    monkeypatch.setattr(AgenticProcess, "load_embedded_skill_action", _fake)


async def test_load_skill_resolves_str_path(monkeypatch):
    captured: dict = {}
    _patch_action(monkeypatch, captured)
    await _proc(WorkerType.CLAUDE_CODE).load_skill("/skills/my-skill")
    assert captured["ref"] == "/skills/my-skill"


async def test_load_skill_resolves_entity_asset_ref_str(monkeypatch):
    captured: dict = {}
    _patch_action(monkeypatch, captured)

    class _SkillEntity:
        asset_ref = "/scope/.claude/skills/my-skill"

    await _proc(WorkerType.CLAUDE_CODE).load_skill(_SkillEntity())
    assert captured["ref"] == "/scope/.claude/skills/my-skill"


async def test_load_skill_resolves_fsref_like_asset_ref(monkeypatch):
    captured: dict = {}
    _patch_action(monkeypatch, captured)

    class _FSRefLike:
        _path = Path("/records/skill/my-skill")

    class _Record:
        asset_ref = _FSRefLike()

    await _proc(WorkerType.CODEX).load_skill(_Record())
    assert captured["ref"] == "/records/skill/my-skill"


async def test_load_skill_unresolvable_returns_fail():
    proc = _proc(WorkerType.CLAUDE_CODE)

    class _Empty:
        asset_ref = None
        record_dir = None

    result = await proc.load_skill(_Empty())
    assert getattr(result, "ok", True) is False or getattr(result, "status", "") != "SUCCESS"
