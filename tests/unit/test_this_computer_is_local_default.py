"""This computer is the local ComputeNode's own placement — and old rows are lifted onto that shape.

``Deployment.this_computer()`` used to be the one row with ``kind == compute.this_computer`` and no
parent, beside a SECOND row parented to the local node (the machine's project-less web placement).
Now it is one row: parent = the local node. ``migration_2026_09_this_computer_placement`` folds the two
(endpoints move, the credential binding stays) and drops an agent's extra local slots.
"""

import json
import uuid

import pytest

from flow_sdk.builtin.deployment import Deployment, _local_node_typeid
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec

pytestmark = pytest.mark.asyncio


async def test_this_computer_is_found_by_its_parent_and_made_once():
    first = await Deployment.this_computer()
    again = await Deployment.this_computer()

    assert first.id == again.id
    assert first.parent_type_id == _local_node_typeid()
    assert first.is_this_computer and first.target.provider == "local"
    assert first.id not in {d.id for d in await Deployment.others()}


async def test_a_project_less_web_app_is_served_from_this_computer():
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.webapp_placement import local_web_deployment

    await ComputeNode.get_local()
    here = await Deployment.this_computer()
    placed = await local_web_deployment(None)

    assert placed.id == here.id, "one placement for the machine, not a second web row"


async def _write_raw(row_id: str, data: dict) -> None:
    """Rewrite a stored row's JSON the way an older build left it (keys the model no longer has)."""
    from sqlalchemy import text

    from flow_sdk.db.drivers.db_driver import get_db_driver

    engine = get_db_driver().engine
    async with engine.begin() as conn:
        blob = (await conn.execute(text("SELECT data FROM entities WHERE id = :id"), {"id": row_id})).scalar_one()
        stored = {**(json.loads(blob) if isinstance(blob, str) else blob), **data}
        await conn.execute(text("UPDATE entities SET data = :data WHERE id = :id"), {"data": json.dumps(stored), "id": row_id})


async def test_the_lift_folds_the_old_rows_into_one(monkeypatch):
    from flow_sdk.cli import app_config
    from flow_sdk.migrations import migration_2026_09_this_computer_placement as lift_module

    monkeypatch.setattr(app_config, "get_config", lambda key, *a, **k: None)
    monkeypatch.setattr(app_config, "set_config", lambda *a, **k: None)
    # The old shape: an unparented this-computer row holding the binding, and the machine's web row.
    legacy = Deployment(
        name="This computer",
        target={"provider": "local", "scope": "machine", "location": "this computer"},
        secrets=DeploymentSecretsSpec(),
    )
    await legacy.save()
    await _write_raw(legacy.id, {"kind": "compute.this_computer", "parent_type_id": None})
    web = Deployment(name="This machine", parent_type_id=_local_node_typeid(), target={"provider": "local", "scope": "m"})
    await web.save()
    await _write_raw(web.id, {"kind": "runtime.web"})
    site = ServiceEndpoint(name="site", parent_type_id=str(web.typeid), protocol={"spec_kind": "web.app"},
                           backend={"type": "static", "root": "/tmp"})
    await site.save()

    dry = await lift_module.lift(dry_run=True)
    assert any("folded" in line for line in dry.moved) and await Deployment.get_by_id(web.id) is not None

    report = await lift_module.lift(dry_run=False)

    assert not report.failed, report.failed
    kept = await Deployment.get_by_id(legacy.id)
    assert kept.parent_type_id == _local_node_typeid() and kept.secrets is not None
    assert await Deployment.get_by_id(web.id) is None
    assert (await ServiceEndpoint.get_by_id(site.id)).parent_type_id == str(kept.typeid)
    assert (await Deployment.this_computer()).id == legacy.id


async def test_the_lift_keeps_one_local_deployment_per_agent(monkeypatch):
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.cli import app_config
    from flow_sdk.migrations import migration_2026_09_this_computer_placement as lift_module

    monkeypatch.setattr(app_config, "get_config", lambda key, *a, **k: None)
    monkeypatch.setattr(app_config, "set_config", lambda *a, **k: None)
    agent = await Agent(name=f"slots-{uuid.uuid4().hex[:6]}", worker_type="claude").save()
    default = await agent.deploy("local")
    extra = Deployment(name="second", parent_type_id=str(agent.typeid), target={"provider": "local", "scope": "m"})
    await extra.save()
    await _write_raw(extra.id, {"slot": "2"})

    report = await lift_module.lift(dry_run=False)

    assert not report.failed, report.failed
    assert [d.id for d in await agent.deployments()] == [default.id]
