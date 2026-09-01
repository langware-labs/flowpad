"""Worker-aware skill loading: ``_skills_root`` routes per worker and
``load_skill`` resolves a Skill entity / record / path to its source folder.

Pure unit — no DB, no live worker (``load_embedded_skill_action`` is stubbed to
capture what ``load_skill`` forwards)."""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeAgentOptions
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


def _proc(worker_type: WorkerType) -> AgenticProcess:
    return AgenticProcess(worker_type=worker_type, workdir="/tmp/wd")


def test_skills_root_is_per_vendor_under_the_mounted_assets_dir():
    """Each vendor reads its OWN dot-dir. Copilot's is ``.github/skills`` — from
    its own ``--add-dir`` help text ("load its .github/skills and .github/agents
    as trusted configuration"); pointing it at claude's ``.claude/skills``
    dropped every embedded skill somewhere copilot never looks."""
    assets = Path("/tmp/assets")
    assert _proc(WorkerType.CLAUDE_CODE)._skills_root(assets) == assets / ".claude" / "skills"
    assert _proc(WorkerType.COPILOT)._skills_root(assets) == assets / ".github" / "skills"
    assert _proc(WorkerType.OPENCODE)._skills_root(assets) == assets / ".opencode" / "skills"


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


# ---------------------------------------------------------------------------
# Delivery: laying the files down is only half of "the worker can see it".
# ---------------------------------------------------------------------------


@pytest.fixture
def no_save(monkeypatch):
    async def save(entity, *args, **kwargs):
        return entity

    monkeypatch.setattr(AgenticProcess, "save", save)


@pytest.fixture
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


def _skill_folder(tmp_path: Path, name: str = "probe-skill") -> Path:
    folder = tmp_path / "src" / name
    folder.mkdir(parents=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: A probe skill.\n---\n\n# {name}\n"
    )
    return folder


async def test_load_embedded_skill_registers_the_ref(no_save, records_root, tmp_path):
    """The symlink alone is invisible: without a ref, every delivery predicate
    reads False on the next request's fresh entity and the assets dir is never
    mounted."""
    proc = _proc(WorkerType.CLAUDE_CODE)
    result = await proc.load_embedded_skill_action(asset_ref=str(_skill_folder(tmp_path)))

    assert result.data["ok"] is True
    assert Path(result.data["link"]).is_symlink()
    refs = [str(r) for r in proc.embedded_asset_refs]
    assert len(refs) == 1 and refs[0].startswith("skill-")
    # The whole point of the ref: the assets dir now reaches the worker.
    assert str(proc._process_assets_path()) in proc.resolved_add_dirs


async def test_load_embedded_skill_is_idempotent(no_save, records_root, tmp_path):
    """Re-loading the same folder must converge, not grow the list — the id comes
    from the identity carrier, never a fresh uuid per call."""
    proc = _proc(WorkerType.CLAUDE_CODE)
    folder = str(_skill_folder(tmp_path))
    await proc.load_embedded_skill_action(asset_ref=folder)
    await proc.load_embedded_skill_action(asset_ref=folder)

    assert len(proc.embedded_asset_refs) == 1


async def test_detach_removes_a_symlinked_skill(no_save, records_root, tmp_path):
    """rmtree raises on a symlink, so detach has to unlink it — and must never
    recurse into the user's real skill folder."""
    proc = _proc(WorkerType.CLAUDE_CODE)
    folder = _skill_folder(tmp_path)
    result = await proc.load_embedded_skill_action(asset_ref=str(folder))
    link = Path(result.data["link"])

    await proc._unmaterialize_entity(proc.embedded_asset_refs[0], proc._process_assets_path())

    assert not link.is_symlink()
    assert (folder / "SKILL.md").exists(), "the source skill must survive a detach"


async def test_assets_are_prepared_without_any_instruction_text(no_save, records_root, tmp_path):
    """A process can have skills and nothing to say. Gating the MOUNT on the
    instruction TEXT is what starved opencode's config and copilot's custom
    instruction dirs whenever a process had a skill but no persona."""
    proc = _proc(WorkerType.OPENCODE)
    await proc.load_embedded_skill_action(asset_ref=str(_skill_folder(tmp_path)))

    assets = await proc._prepare_system_instruction_assets()

    assert assets is not None, "assets with no instruction text must still be delivered"
    assert assets.assets_dir == proc._process_assets_path()
    assert assets.instructions == ""
    assert assets.claude_file is None
    assert not (assets.assets_dir / "CLAUDE.md").exists()


async def test_no_instruction_text_means_no_system_prompt_file(no_save, records_root, tmp_path):
    """The mount applies; the system-prompt flag must not, or the worker is
    pointed at a file that was never written."""
    proc = _proc(WorkerType.CLAUDE_CODE)
    await proc.load_embedded_skill_action(asset_ref=str(_skill_folder(tmp_path)))
    assets = await proc._prepare_system_instruction_assets()

    cmd = ClaudeAgentOptions()
    cmd.apply_instruction_assets(assets)

    assert cmd.system_prompt_file is None
    assert str(assets.assets_dir) in cmd.add_dirs


async def test_nothing_at_all_still_prepares_nothing(no_save, records_root):
    """The other early return stays: a process with no assets and no text has
    nothing to mount."""
    assert await _proc(WorkerType.CLAUDE_CODE)._prepare_system_instruction_assets() is None
