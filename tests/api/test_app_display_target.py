"""How an app is addressed for display.

The address is the Artifact — the one thing about an app that stays true. Which
endpoint is shown (its dev server, or built output we serve) is DERIVED from its
endpoints at resolve time, because that changes without the app changing. These
tests pin that derivation, since regressing it is how a stale port becomes an
app's identity again. A bare dev server is shown by the endpoint registered for it.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.builtin.webapp_placement import register_dev_endpoint
from flow_sdk.core.display_target import (
    DisplayTargetKind,
    DisplayTargetNotFound,
    InvalidDisplayTarget,
    resolve_display_target,
)


async def _artifact(name: str = "Todo") -> Artifact:
    artifact = Artifact(name=name, kind="application.web", description="A todo app")
    await artifact.save()
    return artifact


async def _deployment(artifact: Artifact) -> Deployment:
    deployment = Deployment(
        name=f"{artifact.name} (local)",
        kind="runtime.web",
        artifact_id=artifact.id,
        target={"provider": "local", "scope": "machine"},
    )
    await deployment.save()
    return deployment


async def _endpoint(artifact: Artifact, deployment: Deployment, backend: dict, **over) -> ServiceEndpoint:
    endpoint = ServiceEndpoint(
        parent_type_id=str(deployment.typeid),
        name=artifact.name,
        protocol={"spec_kind": "web.app"},
        backend=backend,
        artifact_id=artifact.id,
        **over,
    )
    await endpoint.save()
    return endpoint


async def _dev(artifact: Artifact, port: int) -> ServiceEndpoint:
    return await _endpoint(artifact, await _deployment(artifact), {"type": "proxy", "port": port})


async def _served(artifact: Artifact, tmp_path) -> ServiceEndpoint:
    return await _endpoint(artifact, await _deployment(artifact), {"type": "static", "root": str(tmp_path / "dist")})


@pytest.mark.asyncio
async def test_dev_server_wins_when_one_is_running(bootstrapped_client, user, tmp_path):
    """Both runtimes present → the live dev server is what the user is working on."""
    artifact = await _artifact()
    dev = await _dev(artifact, 3300)
    await _served(artifact, tmp_path)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["kind"] == DisplayTargetKind.APP
    assert target["artifact_id"] == artifact.id
    assert target["typeid"] == str(artifact.typeid), "the artifact stays the address"
    assert target["name"] == "Todo"
    assert target["runtime"] == "dev"
    assert target["endpoint_id"] == dev.id
    assert "port" not in target, "a port is how the endpoint is reached, never the address"


@pytest.mark.asyncio
async def test_served_when_there_is_no_dev_server(bootstrapped_client, user, tmp_path):
    artifact = await _artifact("Served only")
    served = await _served(artifact, tmp_path)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "served"
    assert target["endpoint_id"] == served.id


@pytest.mark.asyncio
async def test_unbuilt_app_still_resolves(bootstrapped_client, user, tmp_path):
    """An app with neither runtime is addressable — that is what lets the
    display say "not built yet" instead of showing nothing at all."""
    artifact = await _artifact("Nothing yet")

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "unbuilt"
    assert target["artifact_id"] == artifact.id
    assert "endpoint_id" not in target


@pytest.mark.asyncio
async def test_a_static_endpoint_is_the_served_runtime(bootstrapped_client, user, tmp_path):
    artifact = await _artifact("Built")
    await _endpoint(artifact, await _deployment(artifact), {"type": "static", "root": str(tmp_path)})

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "served"
    assert "micro_app_id" not in target


@pytest.mark.asyncio
async def test_a_cloud_placements_endpoint_is_not_a_port_here(bootstrapped_client, user, tmp_path):
    """A hub row adopted here (`remote`) serves the app on another machine."""
    artifact = await _artifact("Elsewhere")
    await _endpoint(artifact, await _deployment(artifact), {"type": "proxy", "port": 3300}, remote=True)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "unbuilt"


@pytest.mark.asyncio
async def test_bad_addresses_are_rejected(bootstrapped_client, user):
    with pytest.raises(InvalidDisplayTarget):
        await resolve_display_target(artifact_id="not-a-uuid")

    with pytest.raises(DisplayTargetNotFound):
        await resolve_display_target(artifact_id=str(mint_uuid("app:absent")))


@pytest.mark.asyncio
async def test_an_endpoint_is_shown_by_its_own_typeid(bootstrapped_client, user, tmp_path):
    artifact = await _artifact("Direct")
    dev = await _dev(artifact, 3301)

    target = await resolve_display_target(typeid=str(dev.typeid))

    assert target == {
        "kind": DisplayTargetKind.APP,
        "typeid": f"service_endpoint-{dev.id}",
        "endpoint_id": dev.id,
        "name": "Direct",
        "runtime": "dev",
    }


@pytest.mark.asyncio
async def test_a_bare_port_is_registered_once_as_this_machines_dev_endpoint(bootstrapped_client, user):
    """`flow show webapp --port N`: the port gets an endpoint, and showing it again finds that one."""
    first = await register_dev_endpoint(None, port=4321)
    again = await register_dev_endpoint(None, port=4321)

    assert again.id == first.id
    assert first.backend.type == "proxy" and first.backend.port == 4321
    assert first.name == "port-4321"
    assert first.supports_direct_access, "a dev server is its own origin — HMR, absolute /src paths"
    placement = await Deployment.get_by_id(first.parent_type_id.split("-", 1)[1])
    assert placement.parent_type_id.startswith("compute_node-"), "no project → the machine's placement"

    renamed = await register_dev_endpoint(None, port=4321, name="storefront")
    assert renamed.id == first.id and renamed.name == "storefront"
