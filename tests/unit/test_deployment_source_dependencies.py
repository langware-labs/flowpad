"""An Agent's own source declarations reach new deployment sessions and worker turns."""

from pathlib import Path

import pytest

from flow_sdk.assets import flow_json
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.schema.data_spec.flow_json_spec import AssetFlowJsonSpec, FlowDependency
from tests.unit.test_asset_dependencies import _layers, _project
from tests.unit.test_asset_dependencies_snippets import DOCS, drive  # noqa: F401 — shared loopback Drive fixture

pytestmark = pytest.mark.timeout(15)  # do not increase timeout without approval


def _declare(asset, source, name):
    flow_json.write_dependency(
        Path(asset.asset_ref), FlowDependency(name=name, source=str(source.typeid)), AssetFlowJsonSpec,
    )


async def _agent(project):
    agent = Agent(name=f"policy-reader-{project.id}", project_id=str(project.id),
                  worker_type="claude", load_flowpad_assistant=False,
                  asset_ref=str(Path(project.fs_storage_mount_path) / "agentic-assets" / "agent" / "policy-reader"))
    await agent.save()
    assert Path(agent.asset_ref).resolve().is_relative_to(Path(project.fs_storage_mount_path).resolve()), (agent.asset_ref, project.fs_storage_mount_path)
    return agent


async def test_new_session_reads_fresh_agent_declarations_without_changing_existing_session(tmp_path):
    (personal, team, company), _ = await _layers(tmp_path)
    owner = await _project(tmp_path, "agent-owner")
    agent = await _agent(owner)
    deployment = await agent.local_deployment()
    before = await deployment.create_process()
    _declare(agent, personal, "personal")

    after = await deployment.create_process()

    roots = {source.files_root for source in (personal, team, company)}
    assert roots <= set(after.additional_dirs)
    assert roots.isdisjoint(before.additional_dirs)
    assert after.project_id == owner.id


async def test_foreign_agent_keeps_acting_project_and_gets_own_source_chain(tmp_path):
    (personal, team, company), _ = await _layers(tmp_path)
    owner = await _project(tmp_path, "agent-owner")
    acting = await _project(tmp_path, "acting-project")
    context = tmp_path / "acting-context"
    context.mkdir()
    await acting.add_dependency(str(context), name="acting-context")
    agent = await _agent(owner)
    _declare(agent, personal, "personal")

    process = await agent.use(project_id=str(acting.id))
    await process.get_project()

    assert process.project_id == acting.id
    assert Path(process.workdir) == Path(acting.fs_storage_mount_path)
    assert {source.files_root for source in (personal, team, company)} <= set(process.resolved_add_dirs)
    assert str(context) in process.resolved_add_dirs
    assert owner.fs_storage_mount_path in process.additional_dirs


@pytest.mark.usefixtures("drive")
async def test_agent_worker_reads_all_three_drive_docs_from_one_attachment(tmp_path, mock_driver):
    sources = []
    driver = await DataDriver.get("gdrive")
    for name, folder in (("company", "Company"), ("team", "Sales"), ("personal", "Dana")):
        project = await _project(tmp_path, name)
        source = driver.create_source(driver.create_config(path=f"Knowledge/{folder}"),
                                      name=f"{name}-{project.id}", reflect="none", read_only=True,
                                      project_id=str(project.id))
        await source.save()
        await source.verify()
        await source.sync()
        sources.append(source)
    company, team, personal = sources
    _declare(team, company, "company")
    _declare(personal, team, "team")
    owner = await _project(tmp_path, "reader")
    agent = await _agent(owner)
    _declare(agent, personal, "personal")

    def read_policies(turn):
        documents = {path.name: turn.read(path) for root in turn.process.resolved_add_dirs
                     for path in Path(root).glob("*.md")}
        return "\n".join(documents.get(name, "missing") for name in
                         ("Company handbook.md", "Sales playbook.md", "Dana notes.md"))

    worker = mock_driver(read_policies)
    answer = await agent.launch("Read the company, team and personal policies.", wait=True)

    assert answer.ok
    assert all(text.strip() in answer.text for text in DOCS.values())
    assert len(worker.received_prompts) == 1
    assert all(source.files_root not in worker.received_prompts[0] for source in sources)
