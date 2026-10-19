"""Resolve returns the state of sources indexed from scoped dependency folders."""

import json
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.data_source import DataSource
from tests.unit.agent._seed import seed_agent, seed_project


async def test_scoped_source_is_ready_in_the_resolve_that_indexes_it(tmp_path):
    project = await seed_project(tmp_path / "consumer")
    agent = await seed_agent(tmp_path / "consumer", "consumer-agent", project_id=project.id)
    source_id = mint_uuid()
    source_root = tmp_path / "provider" / "agentic-assets" / "data_source" / "mail"
    source_root.mkdir(parents=True)
    (source_root / "data_source.json").write_text(json.dumps({
        "id": source_id, "name": "mail", "data_driver_name": "gmail",
        "data_driver_config": {},
    }))
    (Path(project.fs_storage_mount_path) / "flow.json").write_text(json.dumps({
        "dependencies": {"mail-root": f"file:{source_root}"},
    }))
    (Path(agent.asset_ref) / "flow.json").write_text(json.dumps({
        "dependencies": {"mail": f"data_source-{source_id}"},
    }))
    assert await DataSource.get_by_id(source_id) is None
    states = await project_dependencies.resolve(project, fetch=False)
    assert await DataSource.get_by_id(source_id) is not None
    assert [(s.name, s.state) for s in states] == [("mail-root", "ready"), ("mail", "ready")]
    assert states[1].typeid == f"data_source-{source_id}"
