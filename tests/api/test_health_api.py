"""Health over the real app: ``service_endpoint/<id>/health`` and ``compute_node/@local/health``.

The services are real — a loopback server (``ServiceUpstream``), a directory, a port nothing listens
on — and the requests go through the real FastAPI app, so the report the hub's control plane reads
from a box is the one production answers. A check's result is recorded on the endpoint only when its
state changed.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.schema.data_spec.service_endpoint_spec import PROTOCOL_API_REST, PROTOCOL_WEB_APP
from tests.utils.service_upstream import ServiceUpstream, _free_port


@pytest.fixture(scope="module")
def upstream():
    server = ServiceUpstream().start()
    yield server
    server.stop()


async def _local_deployment() -> Deployment:
    """A placement on THIS machine (provider ``local`` resolves to the ``@local`` node)."""
    from flow_sdk.builtin.deployment import KIND_WEB  # noqa: PLC0415 — goes when Deployment.kind does

    row = Deployment(
        name=f"health-{uuid.uuid4().hex[:6]}",
        kind=KIND_WEB,
        parent_type_id=f"project-{uuid.uuid4()}",
        target={"provider": "local", "scope": "machine", "location": "here"},
    )
    await row.save()
    return row


async def _endpoint(deployment: Deployment, name: str, backend: dict, **over) -> ServiceEndpoint:
    endpoint = ServiceEndpoint(
        name=name,
        parent_type_id=str(deployment.typeid),
        protocol={"spec_kind": over.pop("kind", PROTOCOL_WEB_APP)},
        backend=backend,
        **over,
    )
    await endpoint.save()
    return endpoint


async def test_an_endpoint_answers_its_health_and_records_it(client, upstream):
    deployment = await _local_deployment()
    endpoint = await _endpoint(deployment, "app", {"type": "proxy", "port": upstream.port, "health": "echo"})

    resp = await client.get(f"/api/v1/graph/service_endpoint/{endpoint.id}/health")

    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    assert body["state"] == "alive" and body["endpoint_id"] == endpoint.id
    stored = await ServiceEndpoint.get_by_id(endpoint.id)
    assert stored.health is not None and stored.health.state == "alive"


async def test_a_dead_service_reports_failing(client):
    deployment = await _local_deployment()
    endpoint = await _endpoint(deployment, "api", {"type": "proxy", "port": _free_port()}, kind=PROTOCOL_API_REST)

    body = (await client.get(f"/api/v1/graph/service_endpoint/{endpoint.id}/health")).json()["data"]

    assert body["state"] == "failing"


async def test_an_unchanged_state_is_not_saved_again(upstream, monkeypatch):
    deployment = await _local_deployment()
    endpoint = await _endpoint(deployment, "app", {"type": "proxy", "port": upstream.port, "health": "echo"})
    await endpoint.health_check()
    saves = []
    original = ServiceEndpoint.save

    async def _counting_save(self, *a, **kw):
        saves.append(self.id)
        return await original(self, *a, **kw)

    monkeypatch.setattr(ServiceEndpoint, "save", _counting_save)
    await endpoint.health_check()

    assert saves == [], "a check that found the same state must not write"


async def test_the_node_report_lists_every_service_on_the_machine(client, upstream, tmp_path):
    first, second = await _local_deployment(), await _local_deployment()
    alive = await _endpoint(first, "app", {"type": "proxy", "port": upstream.port, "health": "echo"})
    dead = await _endpoint(first, "api", {"type": "proxy", "port": _free_port()}, kind=PROTOCOL_API_REST)
    site = await _endpoint(second, "site", {"type": "static", "root": str(tmp_path)})
    local = await ComputeNode.get_local()

    resp = await client.get("/api/v1/graph/compute_node/@local/health")

    assert resp.status_code == 200, resp.text
    report = resp.json()["data"]
    assert report["node_id"] == local.id
    by_id = {e["endpoint_id"]: e["state"] for e in report["endpoints"]}
    assert by_id[alive.id] == "alive"
    assert by_id[dead.id] == "failing"
    assert by_id[site.id] == "alive"
    assert await first.health() == "failing", "a deployment is as healthy as its least healthy service"
    assert await second.health() == "alive"


async def test_a_cloud_placement_is_not_on_this_node(client):
    cloud = Deployment(
        name="cloud",
        kind="runtime.web",
        parent_type_id=f"project-{uuid.uuid4()}",
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
    )
    await cloud.save()
    elsewhere = await _endpoint(cloud, "site", {"type": "proxy", "port": _free_port()})
    await ComputeNode.get_local()

    report = (await client.get("/api/v1/graph/compute_node/@local/health")).json()["data"]

    assert elsewhere.id not in {e["endpoint_id"] for e in report["endpoints"]}
