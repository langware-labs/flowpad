"""Selecting a new auto-launch agent edits its peers, never their prompts or another project."""
from pathlib import Path

import pytest

from flow_sdk.assets.document import DocumentConflict, DocumentPatch, read_document, update_document
from flow_sdk.builtin.agent import Agent
from flow_sdk.fs_store.reindex import reindex_paths
from flow_sdk.schema.type_info.agent_type_info import AGENT
from tests.unit.agent._seed import seed_agent, seed_project


async def edit(agent, value, revision=None):
    main = Path(agent.asset_ref) / "agent.json"
    patch = DocumentPatch(set_fields={"auto_launch": value})
    async with AGENT.document_edit_context(str(main), patch):
        update_document(main, patch, expected_revision=revision or read_document(main).revision)
        await reindex_paths([str(main)], mint=False)


async def test_second_selection_replaces_first_on_disk_and_index_without_touching_other_project(tmp_path):
    project = await seed_project(tmp_path / "one")
    other_project = await seed_project(tmp_path / "two")
    first = await seed_agent(tmp_path / "one", "first", project_id=project.id, auto_launch=True)
    second = await seed_agent(tmp_path / "one", "second", project_id=project.id)
    unrelated = await seed_agent(tmp_path / "two", "unrelated", project_id=other_project.id, auto_launch=True)
    prompt = Path(first.asset_ref) / "system_prompt.md"
    prompt.write_text("Keep this hand-authored prompt exactly.\n")
    await edit(second, True)
    assert read_document(Path(first.asset_ref) / "agent.json").fields["auto_launch"] is False
    assert (await Agent.get_by_id(first.id)).auto_launch is False
    assert (await Agent.get_by_id(second.id)).auto_launch is True
    assert (await Agent.get_by_id(unrelated.id)).auto_launch is True
    assert prompt.read_text() == "Keep this hand-authored prompt exactly.\n"


async def test_stale_selection_does_not_clear_existing_selection(tmp_path):
    project = await seed_project(tmp_path / "stale")
    first = await seed_agent(tmp_path / "stale", "first", project_id=project.id, auto_launch=True)
    second = await seed_agent(tmp_path / "stale", "second", project_id=project.id)
    with pytest.raises(DocumentConflict):
        await edit(second, True, "sha256:stale")
    assert (await Agent.get_by_id(first.id)).auto_launch is True


async def test_disabling_selection_does_not_select_another_agent(tmp_path):
    project = await seed_project(tmp_path / "disable")
    agent = await seed_agent(tmp_path / "disable", "first", project_id=project.id, auto_launch=True)
    await edit(agent, False)
    assert (await Agent.get_by_id(agent.id)).auto_launch is False


async def test_selection_clears_direct_context_agent_but_not_transitive_context(tmp_path):
    from tests.unit._project_deps import link_context_dirs

    project = await seed_project(tmp_path / "owner")
    direct = await seed_project(tmp_path / "direct")
    transitive = await seed_project(tmp_path / "transitive")
    await link_context_dirs(project, [tmp_path / "direct"])
    await link_context_dirs(direct, [tmp_path / "transitive"])
    first = await seed_agent(tmp_path / "direct", "first", project_id=direct.id, auto_launch=True)
    distant = await seed_agent(tmp_path / "transitive", "distant", project_id=transitive.id, auto_launch=True)
    second = await seed_agent(tmp_path / "owner", "second", project_id=project.id)
    await edit(second, True)
    assert (await Agent.get_by_id(first.id)).auto_launch is False
    assert (await Agent.get_by_id(distant.id)).auto_launch is True


async def test_concurrent_selections_leave_only_one_flag(tmp_path):
    import asyncio

    project = await seed_project(tmp_path / "concurrent")
    first = await seed_agent(tmp_path / "concurrent", "first", project_id=project.id)
    second = await seed_agent(tmp_path / "concurrent", "second", project_id=project.id)
    await asyncio.gather(edit(first, True), edit(second, True))
    flags = [(await Agent.get_by_id(agent.id)).auto_launch for agent in (first, second)]
    assert sum(flags) == 1


async def test_creating_selected_agent_replaces_previous_authored_selection(tmp_path):
    project = await seed_project(tmp_path / "create")
    first = await seed_agent(tmp_path / "create", "first", project_id=project.id, auto_launch=True)
    second = Agent(name="second", asset_ref=str(tmp_path / "create" / "agentic-assets" / "agent" / "second"),
                   project_id=project.id, auto_launch=True)
    await second.save()
    assert (await Agent.get_by_id(first.id)).auto_launch is False
    assert read_document(Path(first.asset_ref) / "agent.json").fields["auto_launch"] is False
    assert (await Agent.get_by_id(second.id)).auto_launch is True
