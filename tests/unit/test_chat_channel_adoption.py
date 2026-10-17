"""A cloned project's chat channel belongs to the placement serving it here."""

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent_places import adopt_placement
from flow_sdk.builtin.agent_serve import deployment_chat_driver, ensure_chat_channel
from flow_sdk.builtin.data_source import DataSource
from tests.unit.agent._seed import seed_agent, seed_project


async def test_imported_chat_channel_is_adopted_then_follows_placement_rekey(tmp_path):
    project = await seed_project(tmp_path / "imported-chat")
    agent = await seed_agent(tmp_path / "imported-chat", "imported-agent", project_id=project.id)
    driver = deployment_chat_driver()
    old_place = mint_uuid()
    source = driver.create_source(driver.create_config(deployment_id=old_place), name=f"{agent.name} chat",
                                  owner=agent.typeid, answer_place=old_place, status="active")
    await source.save()
    placement = await agent.local_deployment()
    endpoint = await ensure_chat_channel(agent, placement)
    assert endpoint.backend.data_source_id == source.id
    adopted = await DataSource.get_by_id(source.id)
    assert adopted.config[driver.cls.identity_config_key] == adopted.answer_place == placement.id
    new_place = await adopt_placement(agent, mint_uuid())
    again = await ensure_chat_channel(agent, new_place)
    assert again.backend.data_source_id == source.id
    assert (await DataSource.get_by_id(source.id)).answer_place == new_place.id
    assert len(await DataSource.find_owned(agent.typeid)) == 1


async def test_chat_of_an_existing_placement_is_not_adopted(tmp_path):
    from flow_sdk.builtin.deployment import Deployment

    project = await seed_project(tmp_path / "existing-chat")
    agent = await seed_agent(tmp_path / "existing-chat", "existing-agent", project_id=project.id)
    other = Deployment(name="other-place", parent_type_id=str(agent.typeid),
                       target={"provider": "e2b", "scope": "machine", "location": "other"})
    await other.save()
    driver = deployment_chat_driver()
    source = driver.create_source(driver.create_config(deployment_id=other.id), name="Other place chat",
                                  owner=agent.typeid, answer_place=other.id, status="active")
    await source.save()
    endpoint = await ensure_chat_channel(agent, await agent.local_deployment())
    assert endpoint.backend.data_source_id != source.id
    assert (await DataSource.get_by_id(source.id)).answer_place == other.id
