"""Building an Agent with a field it does not have is an error — reading a stale one back is not.

``email_allowed_senders`` was removed from Agent, and every caller that still passed it
kept "working": pydantic's ``extra="ignore"`` dropped the kwarg, so the allowlist a test
thought it had set simply did not exist. A construction names fields on purpose; a row
written before a field was removed is history, and the sqlite list reader SKIPS a row whose
construction raises — so the load paths stay lenient and only construction is strict.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import update

from flow_sdk.builtin.agent import Agent
from flow_sdk.core.entity.entity_model import lenient_entity_load
from flow_sdk.db.drivers.sqlite.connection import EntitySchema
from tests.unit.agent._seed import seed_agent, seed_project

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

STALE = {"email_allowed_senders": ["someone@example.com"]}


def test_constructing_an_agent_with_a_removed_field_raises():
    with pytest.raises(TypeError, match="email_allowed_senders"):
        Agent(name="strict", **STALE)
    with pytest.raises(TypeError, match="email_allowed_senders"):
        Agent.model_validate({"name": "strict", **STALE})


def test_declared_fields_aliases_and_computed_fields_are_accepted():
    agent = Agent(name="strict", description="d", system_prompt="p")
    echoed = agent.model_dump()  # carries computed fields, as a client PUT echoes them
    assert Agent(**echoed).name == "strict"


def test_a_lenient_load_drops_the_stale_field():
    with lenient_entity_load():
        agent = Agent(name="stale", **STALE)
    assert agent.name == "stale" and "email_allowed_senders" not in agent.model_dump()


async def _stale_row(agent: Agent) -> None:
    """Rewrite the saved row's JSON as a build from before the field was removed left it."""
    driver = Agent._db
    driver = getattr(driver, "_driver", None) or driver
    async with driver.session_factory() as session:
        row = await session.get(EntitySchema, str(agent.id))
        data = {**json.loads(row.data), **STALE}
        await session.execute(update(EntitySchema).where(EntitySchema.id == str(agent.id)).values(data=json.dumps(data)))
        await session.commit()


@pytest.mark.asyncio
async def test_a_sqlite_row_with_a_removed_field_still_loads(tmp_path: Path):
    project = await seed_project(tmp_path / "p")
    agent = await seed_agent(Path(project.fs_storage_mount_path), "stale-row", project_id=project.id)
    await _stale_row(agent)

    assert (await Agent.get_one({"id": agent.id})).name == "stale-row"
    assert [a.name for a in await Agent.get_all({"id": agent.id})] == ["stale-row"], (
        "the list reader skipped a row whose JSON carries a removed field"
    )


@pytest.mark.asyncio
async def test_an_agent_json_with_a_removed_field_still_loads(tmp_path: Path):
    from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    project = await seed_project(tmp_path / "p")
    agent = await seed_agent(Path(project.fs_storage_mount_path), "stale-disk", project_id=project.id)
    document = Path(agent.asset_ref) / "agent.json"
    document.write_text(json.dumps({**json.loads(document.read_text()), **STALE}))

    loaded = SchemaRegistry.get("agent").serializer().load(Agent, local_origin_for_path(Path(agent.asset_ref)))
    assert loaded.name == "stale-disk"


@pytest.mark.asyncio
async def test_a_hub_payload_with_a_removed_field_still_loads(tmp_path: Path):
    project = await seed_project(tmp_path / "p")
    agent = await seed_agent(Path(project.fs_storage_mount_path), "stale-hub", project_id=project.id)
    payload = {**agent.model_dump(mode="json"), **STALE}

    assert Agent.from_json(payload).name == "stale-hub"
    agent.apply_field_updates({"description": "moved", **STALE})
    assert agent.description == "moved"
