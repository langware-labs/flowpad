"""Native observations, rather than catalog membership, establish availability."""

import asyncio
import json
import os
import sys
from types import SimpleNamespace

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.catalog import AssetDescriptor, AssetSource, AssetEvidence, AssetUsageKind
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.assets.inventory import reconcile_assets
from flow_sdk.assets.asset_inventory import WorkerAsset, json_command, skill_observations
from flow_sdk.schema.types import EntityType


def make_skill(tmp_path, name):
    path = tmp_path / name
    path.mkdir()
    entity_id = mint_uuid()
    (path / "SKILL.md").write_text(f"---\nid: {entity_id}\nname: {name}\ndescription: Test\n---\nBody.\n")
    return path, f"skill-{entity_id}"


@pytest.mark.asyncio
async def test_unreported_catalog_skill_is_not_available_but_history_survives(tmp_path):
    path, typeid = make_skill(tmp_path, "shadowed")
    candidate = AssetDescriptor(typeid=typeid, source=AssetSource.WORKDIR, posix_path=str(path))
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), load_flowpad_assistant=False)
    assert reconcile_assets([candidate], []) == []
    candidate = candidate.model_copy(update={"usage": [AssetEvidence(kind=AssetUsageKind.TRANSCRIPT_FILE_READ, path=str(path / "SKILL.md"))]})
    assert reconcile_assets([candidate], []) == [candidate]


@pytest.mark.asyncio
async def test_native_plugin_skill_is_reported_without_an_index_row(tmp_path):
    path, typeid = make_skill(tmp_path, "plugin-skill")
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), load_flowpad_assistant=False)
    result = reconcile_assets([], [WorkerAsset(asset_type=EntityType.SKILL, name="plugin:skill", path=path)])
    assert [(row.typeid, row.invocation_name, row.posix_path) for row in result] == [(typeid, "plugin:skill", str(path))]


def test_native_disabled_and_virtual_skills_are_not_file_assets(tmp_path):
    path, _ = make_skill(tmp_path, "skill")
    rows = [
        {"name": "disabled", "path": str(path), "enabled": False},
        {"name": "builtin", "path": "<built-in>"},
        {"name": "enabled", "path": str(path / "SKILL.md"), "enabled": True},
    ]
    assert skill_observations(rows, path_key="path") == [WorkerAsset(asset_type=EntityType.SKILL, name="enabled", path=path)]


@pytest.mark.parametrize("response", [{}, {"skills": None}, {"skills": {}}, {"skills": ["skill"]}])
def test_missing_native_inventory_is_not_an_empty_available_list(response):
    from flow_sdk.assets.asset_inventory import AssetInventoryError, inventory_rows

    with pytest.raises(AssetInventoryError):
        inventory_rows(response, "skills")
    assert inventory_rows({"skills": []}, "skills") == []


@pytest.mark.asyncio
async def test_catalog_agents_and_mcp_require_worker_evidence(tmp_path):
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), load_flowpad_assistant=False)
    candidates = [AssetDescriptor(typeid=f"{kind}-{mint_uuid()}", source=AssetSource.WORKDIR, posix_path=str(tmp_path / kind))
                  for kind in ("subagent", "mcp")]
    assert reconcile_assets(candidates, []) == []
    candidates[1] = candidates[1].model_copy(update={"attached": True})
    assert reconcile_assets(candidates, []) == [candidates[1]]


@pytest.mark.asyncio
async def test_native_invocation_name_is_independent_of_catalog_display_name(tmp_path):
    path, typeid = make_skill(tmp_path, "skill")
    candidate = AssetDescriptor(typeid=typeid, source=AssetSource.WORKDIR, posix_path=str(path), name="Friendly title")
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), load_flowpad_assistant=False)
    result = reconcile_assets([candidate], [WorkerAsset(asset_type=EntityType.SKILL, name="plugin:skill", path=path)])
    assert result[0].name == "Friendly title"
    assert result[0].to_row()["invocation_name"] == "plugin:skill"


@pytest.mark.asyncio
async def test_large_native_inventory_is_not_truncated(tmp_path):
    # The payload exceeds a pipe buffer. Native commands that exit immediately
    # after a buffered stdout write must still deliver their whole inventory.
    payload = [{"name": "skill", "description": "x" * 200_000}]
    source = tmp_path / "inventory.json"
    source.write_text(json.dumps(payload))
    command = [sys.executable, "-c", "import os,sys; os.write(1,open(sys.argv[1],'rb').read()); os._exit(0)", str(source)]
    assert await json_command(command, cwd=str(tmp_path), env=dict(os.environ)) == payload


@pytest.mark.asyncio
async def test_opencode_inventory_commands_do_not_contend_for_native_store(tmp_path, monkeypatch):
    from flow_sdk.assets.worker_inventory import opencode as inventory

    active = 0
    async def command(argv, **kwargs):
        nonlocal active
        assert active == 0, "native inventory commands must not initialize the same DB concurrently"
        active += 1
        await asyncio.sleep(0)  # yield to the other request, without any wait budget
        active -= 1
        return [] if argv[-1] == "skill" else {}

    monkeypatch.setattr(inventory, "json_command", command)
    monkeypatch.setattr(inventory, "inventory_spawn", lambda process, argv: (argv, {}))
    driver = SimpleNamespace(cli_options=lambda p: SimpleNamespace(agent=None), asset_search_roots=lambda p: [])
    process = SimpleNamespace(roots=[], skill_paths=[], agent=None, workdir=str(tmp_path))
    assert await asyncio.gather(inventory.available_assets(process), inventory.available_assets(process)) == [[], []]


@pytest.mark.asyncio
async def test_copilot_does_not_report_incomplete_mount_inventory_as_verified(tmp_path):
    from flow_sdk.assets.asset_inventory import AssetInventoryError
    from flow_sdk.assets.worker_inventory.copilot import available_assets

    agents = tmp_path / ".github/agents"
    agents.mkdir(parents=True)
    (agents / "probe.agent.md").write_text("---\nname: probe\ndescription: Probe\n---\nInstructions.")
    with pytest.raises(AssetInventoryError, match="added directories"):
        await available_assets(SimpleNamespace(add_dirs=[str(tmp_path)]))


@pytest.mark.asyncio
async def test_pending_pty_configuration_is_not_reported_as_loaded(tmp_path):
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), pty_mode=True,
                             restart_required=True, shell_id=mint_uuid())
    response = await process.get_assets_action()
    assert response.data["assets"] == []
    assert "pending restart" in response.data["availability_error"]


@pytest.mark.asyncio
async def test_inventory_resolves_inherited_assistant_setting(tmp_path, monkeypatch):
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "load_flowpad_assistant", False)
    process = AgenticProcess(id=mint_uuid(), workdir=str(tmp_path), pty_mode=True,
                             restart_required=True, shell_id=mint_uuid(), load_flowpad_assistant=None)
    assert (await process.get_assets_action()).data["assistant_enabled"] is False
    process.load_flowpad_assistant = True
    assert (await process.get_assets_action()).data["assistant_enabled"] is True


@pytest.mark.asyncio
async def test_live_inventory_uses_launch_mounts_and_worker_without_mutating_process(tmp_path):
    from flow_sdk.builtin.agentic_process.asset_availability import inventory_process_view
    from flow_sdk.builtin.process_lifecycle import ProcessStatus

    old_dir, new_dir = str(tmp_path / "loaded"), str(tmp_path / "pending")
    process = AgenticProcess(id=mint_uuid(), worker_type="claude_code", workdir=str(tmp_path),
                             additional_dirs=[old_dir], load_flowpad_assistant=False, pty_mode=True,
                             shell_id=mint_uuid(), status=ProcessStatus.RUNNING.value)
    process.last_started_snapshot = process._restart_snapshot_payload()
    process.worker_type = "codex"
    process.__dict__.pop("driver", None)
    process.additional_dirs = [new_dir]
    process.load_flowpad_assistant = True
    process.restart_required = True
    inspection = await inventory_process_view(process)
    assert inspection.driver.name == "claude"
    assert inspection.driver.name != process.driver.name
    assert old_dir in inspection.resolved_add_dirs
    assert new_dir not in inspection.resolved_add_dirs
    assert process.additional_dirs == [new_dir]
    assert process.load_flowpad_assistant is True

    process.pty_mode = False
    next_turn = await inventory_process_view(process)
    assert next_turn.worker_type == "codex"
    assert new_dir in next_turn.resolved_add_dirs
