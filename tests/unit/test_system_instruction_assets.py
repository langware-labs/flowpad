from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    root = tmp_path / "records"
    set_default_records_root(root)
    yield root
    set_default_records_root(original)


def _process(worker_type: WorkerType, tmp_path: Path, **kwargs) -> AgenticProcess:
    return AgenticProcess(
        id=str(uuid.uuid4()),
        worker_type=worker_type,
        workdir=str(tmp_path / "workdir"),
        load_flowpad_assistant=False,
        pty_mode=False,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_embedded_assets_default_none_then_materialized(records_root, tmp_path):
    prompt = "Your name is TEST_AGENT and the time is 2026-07-04T12:34:56Z."
    process = _process(WorkerType.CODEX, tmp_path)

    assert process.embedded_assets is None
    assert process.instructions is None

    process.instructions = prompt
    assets = await process.prepare_system_instruction_assets()

    assert assets is not None
    assert process.embedded_assets is not None
    assert process.embedded_assets.os_path == process._record_dir() / "execution" / "assets"
    assert assets.assets_dir == process.embedded_assets.os_path
    assert str(assets.assets_dir) not in process.additional_dirs
    assert str(assets.assets_dir) in process.resolved_add_dirs

    claude_md = assets.assets_dir / "CLAUDE.md"
    agents_md = assets.assets_dir / "AGENTS.md"
    dot_agents = assets.assets_dir / ".agents"
    copilot_md = assets.assets_dir / ".github" / "instructions" / "flowpad.instructions.md"

    for path in (claude_md, agents_md, dot_agents, copilot_md):
        assert path.exists(), path

    assert claude_md.read_text(encoding="utf-8") == prompt + "\n"
    assert agents_md.read_text(encoding="utf-8") == prompt + "\n"
    assert dot_agents.read_text(encoding="utf-8") == prompt + "\n"
    copilot_text = copilot_md.read_text(encoding="utf-8")
    assert 'applyTo: "**"' in copilot_text
    assert prompt in copilot_text

    kwargs = process._instruction_context_kwargs(assets)
    assert kwargs == {
        "instructions": None,
        "system_prompt_file": str(claude_md),
        "developer_instructions": prompt,
        "custom_instruction_dirs": [str(assets.assets_dir)],
    }


@pytest.mark.asyncio
async def test_no_system_instructions_leaves_assets_uncreated(records_root, tmp_path):
    process = _process(WorkerType.CODEX, tmp_path)

    assets = await process.prepare_system_instruction_assets()

    assert assets is None
    assert process.embedded_assets is None
    assert process.additional_dirs == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "worker_type",
    [WorkerType.CLAUDE_CODE, WorkerType.CODEX, WorkerType.COPILOT],
)
async def test_system_instruction_assets_applied_to_worker_options(records_root, tmp_path, worker_type):
    prompt = "Your name is TEST_AGENT and the time is 2026-07-04T12:34:56Z."
    process = _process(worker_type, tmp_path, context_data={"instructions": prompt})

    assets = await process.prepare_system_instruction_assets()
    assert assets is not None

    cmd = process.driver.cli_options(process)
    process._apply_system_instruction_assets(cmd, assets)

    assert str(assets.assets_dir) in getattr(cmd, "add_dirs", [])
    assert cmd.system_prompt_append is None
    assert cmd.system_prompt_file == str(assets.claude_file)

    if worker_type is WorkerType.CODEX:
        assert cmd.developer_instructions == prompt
    if worker_type is WorkerType.COPILOT:
        assert cmd.custom_instruction_dirs == [str(assets.assets_dir)]
        assert cmd.no_custom_instructions is False


@pytest.mark.asyncio
async def test_load_embedded_agent_materializes_into_instruction_assets(records_root, tmp_path, monkeypatch):
    async def _save_noop(self):
        return self

    monkeypatch.setattr(AgenticProcess, "save", _save_noop)
    agent_md = tmp_path / "persona-probe.md"
    agent_md.write_text(
        "---\nname: persona-probe\ndescription: Test persona probe\n---\n\nAlways answer as PERSONA_PROBE.\n",
        encoding="utf-8",
    )
    process = _process(WorkerType.CLAUDE_CODE, tmp_path)

    result = await process.load_embedded_agent_action(str(agent_md))
    assert result.status == "SUCCESS"
    assert result.data["ok"] is True
    assert result.data["name"] == "persona-probe"
    # Identity is persisted as the agent's ENTITY ref, not a legacy name entry.
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.subagent import subagent_peek_entity_id
    from flow_sdk.fs_store.record_types import RecordType

    expected_ref = f"subagent-{subagent_peek_entity_id(FSRef(agent_md, record_type=RecordType.SUBAGENT))}"
    assert result.data["ref"] == expected_ref
    assert [str(r) for r in process.embedded_asset_refs] == [expected_ref]
    assert not process.embedded_agent_ids

    materialized = process.embedded_assets.os_path / ".claude" / "agents" / "persona-probe.md"
    assert materialized.exists()
    assert "Always answer as PERSONA_PROBE." in materialized.read_text(encoding="utf-8")

    assets = await process.prepare_system_instruction_assets()
    assert assets is not None
    claude_text = assets.claude_file.read_text(encoding="utf-8")
    assert "# You are the 'persona-probe' agent" in claude_text
    assert "Always answer as PERSONA_PROBE." in claude_text


@pytest.mark.asyncio
async def test_persona_survives_fresh_entity_instance(records_root, tmp_path, monkeypatch):
    """Vibe-display RCA: the embed request and the prompt/launch request run on
    DIFFERENT entity instances (save() invalidates the entity cache), so the
    launch-time instance has no in-memory _embedded_assets handle. The persona
    must still be detected from persisted state (embedded_asset_refs) or the
    generated CLAUDE.md — and with it the vibe `flow show` contract — is
    silently skipped."""

    async def _save_noop(self):
        return self

    monkeypatch.setattr(AgenticProcess, "save", _save_noop)
    agent_md = tmp_path / "vibe-probe.md"
    agent_md.write_text(
        "---\nname: vibe-probe\ndescription: Vibe persona probe\n---\n\n"
        "Always run flow show after every deliverable.\n",
        encoding="utf-8",
    )
    proc_id = str(uuid.uuid4())

    def make_process(**extra) -> AgenticProcess:
        return AgenticProcess(
            id=proc_id,
            worker_type=WorkerType.CLAUDE_CODE,
            workdir=str(tmp_path / "workdir"),
            load_flowpad_assistant=False,
            pty_mode=False,
            **extra,
        )

    # Instance A: the request that handled load-embedded-agent (UI embed call).
    proc_a = make_process()
    result = await proc_a.load_embedded_agent_action(str(agent_md))
    assert result.status == "SUCCESS"

    # Instance B: the fresh instance the prompt/launch request operates on,
    # carrying only the PERSISTED fields of the DB row — not the in-memory
    # _embedded_assets handle.
    proc_b = make_process(
        embedded_asset_refs=[str(r) for r in proc_a.embedded_asset_refs],
        additional_dirs=list(proc_a.additional_dirs or []),
    )
    assert proc_b.embedded_assets is None

    assets = await proc_b.prepare_system_instruction_assets()

    assert assets is not None, "persona lost: prepare returned None on fresh instance"
    claude_text = assets.claude_file.read_text(encoding="utf-8")
    assert "# You are the 'vibe-probe' agent" in claude_text
    assert "Always run flow show after every deliverable." in claude_text
