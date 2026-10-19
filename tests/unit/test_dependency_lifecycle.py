"""Dependency API wiring: provider identity and lifecycle stay separate from its consumer."""
from __future__ import annotations

import pytest

from flow_sdk.builtin import project_dependencies
from flow_sdk.core.setup.load import load_state
from flow_sdk.schema.data_spec.asset_setup_spec import LoadState
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)


async def test_add_exposes_provider_home_and_calls_the_shared_lifecycle(tmp_path):
    consumer = await seed_project(tmp_path / "consumer")
    provider = await seed_project(tmp_path / "provider")
    agent = await seed_agent(tmp_path / "provider", "provider-home")
    await provider.set_home_page_action(typeid=str(agent.typeid))

    response = await consumer.add_dependency_action(source=provider.fs_storage_mount_path, name="service")
    assert response.data["dependency"]["name"] == "service"
    await project_dependencies.settled(str(consumer.id))
    row = (await consumer.dependencies_action()).data["dependencies"][0]
    assert row["state"] == "ready" and row["project_id"] == provider.id
    assert row["home_page"] == str(agent.typeid)
    assert row["lifecycle"]["state"] == "ready"
    assert load_state(str(provider.id)).state is LoadState.READY
    assert load_state(str(consumer.id)) is None
    listed = (await consumer.dependencies_action()).data["dependencies"][0]
    assert listed["project_id"] == row["project_id"] and listed["lifecycle"] == row["lifecycle"]


async def test_add_indexes_the_provider_before_its_home_page_is_opened(tmp_path, monkeypatch):
    """The row's Open goes straight to the provider's home asset, so adding must index it."""
    import flow_sdk.fs_store.indexer.auto_index as auto_index

    indexed: list[str] = []

    async def record(project_id):
        indexed.append(project_id)

    monkeypatch.setattr(auto_index, "index_dependency_provider", record)
    consumer = await seed_project(tmp_path / "consumer")
    provider = await seed_project(tmp_path / "provider")
    await consumer.add_dependency_action(source=provider.fs_storage_mount_path, name="service")
    await project_dependencies.settled(str(consumer.id))
    assert indexed == [str(provider.id)]


async def test_load_refuses_an_asset_owned_by_a_different_project(tmp_path):
    provider = await seed_project(tmp_path / "provider")
    other = tmp_path / "other"
    await seed_project(other)
    agent = await seed_agent(other, "foreign")
    response = await provider.load_action(approved=True, asset=str(agent.typeid))
    assert response.status_code == 400
    assert load_state(str(provider.id)) is None


async def test_relative_provider_home_is_resolved_in_add_and_list_payloads(tmp_path):
    import json

    from flow_sdk.assets.project_manifest import set_home_page
    from flow_sdk.core import Entity
    from flow_sdk.fs_store.reindex import reindex_paths
    from flow_sdk.fs_store.type_id import TypeId

    consumer = await seed_project(tmp_path / "consumer")
    root = tmp_path / "portable-provider"
    provider = await seed_project(root)
    folder = root / "agentic-assets/webapp/admin"
    folder.mkdir(parents=True)
    (folder / "webapp.json").write_text(json.dumps({"name": "admin"}))
    (folder / "index.html").write_text("<h1>Admin</h1>")
    await reindex_paths([str(folder)])
    app = await Entity.get_by_asset_ref(str(folder), resolve_containing=True, strict=True)
    set_home_page(root, "./agentic-assets/webapp/admin")

    await consumer.add_dependency_action(source=provider.fs_storage_mount_path, name="service")
    await project_dependencies.settled(str(consumer.id))
    listed = (await consumer.dependencies_action()).data["dependencies"][0]
    for row in (listed,):
        assert row["home_page"] == str(app.typeid)
        assert TypeId(row["home_page"]).type == "micro_app"
        assert row["project_id"] == provider.id


async def test_the_add_action_answers_before_the_slow_index_and_load(tmp_path, monkeypatch):
    """Indexing a big folder takes minutes: the request returns once flow.json is written."""
    import asyncio

    import flow_sdk.fs_store.indexer.auto_index as auto_index

    gate = asyncio.Event()

    async def slow(project_id):
        await gate.wait()

    monkeypatch.setattr(auto_index, "index_dependency_provider", slow)
    consumer = await seed_project(tmp_path / "consumer")
    provider = await seed_project(tmp_path / "provider")
    response = await asyncio.wait_for(
        consumer.add_dependency_action(source=provider.fs_storage_mount_path, name="service"), 1
    )
    assert response.status == "SUCCESS" and response.data["dependency"]["name"] == "service"
    assert project_dependencies.is_resolving(str(consumer.id))
    gate.set()
    await project_dependencies.settled(str(consumer.id))
    assert not project_dependencies.is_resolving(str(consumer.id))
