"""Dependency API wiring: provider identity and lifecycle stay separate from its consumer."""
from __future__ import annotations

import pytest

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
    row = response.data["dependency"]
    assert row["state"] == "ready" and row["project_id"] == provider.id
    assert row["home_page"] == str(agent.typeid)
    assert row["lifecycle"]["state"] == "ready"
    assert load_state(str(provider.id)).state is LoadState.READY
    assert load_state(str(consumer.id)) is None
    listed = (await consumer.dependencies_action()).data["dependencies"][0]
    assert listed["project_id"] == row["project_id"] and listed["lifecycle"] == row["lifecycle"]


async def test_load_refuses_an_asset_owned_by_a_different_project(tmp_path):
    provider = await seed_project(tmp_path / "provider")
    other = tmp_path / "other"
    await seed_project(other)
    agent = await seed_agent(other, "foreign")
    response = await provider.load_action(approved=True, asset=str(agent.typeid))
    assert response.status_code == 400
    assert load_state(str(provider.id)) is None
