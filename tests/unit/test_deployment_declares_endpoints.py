"""A deployment declares the services it exposes (``Deployment.exposes``); its endpoints serve that.

The declaration is the deployment's own: name, what for (``subkind``), what it speaks, how to tell it is
alive, and — when it is known — how it is served. ``sync_endpoints()`` makes the rows match it (found by
name, never a derived id); a declared service no row serves is failing in the node's health report.
"""

import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import EndpointDeclaration

pytestmark = pytest.mark.asyncio


def declared(name, subkind="service", backend=None, **over):
    return EndpointDeclaration(name=name, subkind=subkind, protocol={"spec_kind": "api.rest"}, backend=backend, **over)


async def _local_deployment() -> Deployment:
    row = Deployment(name=f"d-{uuid.uuid4().hex[:6]}", parent_type_id=f"project-{uuid.uuid4()}",
                     target={"provider": "local", "scope": "m"})
    await row.save()
    return row


async def test_declaring_by_name_replaces_and_reports_a_change():
    deployment = Deployment(name="d", target={"provider": "local", "scope": "m"})

    assert deployment.declare(declared("api")) is True
    assert deployment.declare(declared("api")) is False, "the same declaration is not a change"
    assert deployment.declare(declared("api", subkind="admin")) is True
    assert [(d.name, d.subkind) for d in deployment.exposes] == [("api", "admin")]


async def test_sync_makes_a_row_per_declared_service_found_by_name(tmp_path):
    deployment = await _local_deployment()
    deployment.declare(
        declared("api", backend={"type": "proxy", "port": 8123}, check={"type": "command", "cmd": "true"}),
        declared("site", subkind="app", backend={"type": "static", "root": str(tmp_path)}),
    )
    await deployment.save()

    first = await deployment.sync_endpoints()
    again = await deployment.sync_endpoints()

    assert [e.id for e in first] == [e.id for e in again], "rows are found by name, never re-minted"
    api = await ServiceEndpoint.find_existing(str(deployment.typeid), "api")
    assert api.subkind == "service" and api.check is not None and api.check.type == "command"
    site = await ServiceEndpoint.find_existing(str(deployment.typeid), "site")
    assert site.subkind == "app" and site.backend.type == "static"


async def test_a_declaration_with_no_backend_yet_waits_for_whoever_places_it():
    deployment = await _local_deployment()
    deployment.declare(declared("chat", subkind="agent"))
    await deployment.save()

    assert await deployment.sync_endpoints() == []
    assert await ServiceEndpoint.find_existing(str(deployment.typeid), "chat") is None


async def test_an_agent_deployment_declares_its_chat():
    agent = await Agent(name=f"decl-{uuid.uuid4().hex[:6]}", worker_type="claude").save()

    deployment = await agent.deploy("local")

    assert [(d.name, d.subkind, d.protocol.kind) for d in deployment.exposes] == [("chat", "agent", "api.chat.openai")]


async def test_a_declared_service_nothing_serves_is_failing_in_the_node_report():
    await ComputeNode.get_local()
    deployment = await _local_deployment()
    deployment.declare(declared("db", backend=None))
    await deployment.save()

    report = await (await ComputeNode.get_local()).health_check()

    db = [e for e in report.endpoints if e.name == "db"]
    assert db and db[0].state == "failing" and "not served" in db[0].detail


async def test_a_paused_agent_placement_promises_nothing():
    await ComputeNode.get_local()
    agent = await Agent(name=f"paused-{uuid.uuid4().hex[:6]}", worker_type="claude").save()
    deployment = await agent.deploy("local")  # declared chat; not serving

    report = await (await ComputeNode.get_local()).health_check()

    assert deployment.serving is False
    assert not [e for e in report.endpoints if e.name == "chat" and deployment.name in e.detail]
