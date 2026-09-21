"""How an app is addressed for display.

The address is the Artifact — the one thing about an app that stays true. Which
runtime is live (a dev server, or built output we serve) is DERIVED from its
companions at resolve time, because that changes without the app changing. These
tests pin that derivation, since regressing it is how a stale port becomes an
app's identity again.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.faas.micro_app import MicroApp
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.core.display_target import (
    DisplayTargetKind,
    DisplayTargetNotFound,
    InvalidDisplayTarget,
    resolve_display_target,
)
from flow_sdk.schema.data_spec.app_location_type import AppLocationType


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


async def _micro_app(artifact: Artifact, tmp_path) -> MicroApp:
    # No id is supplied: a delivery row is found by the artifact it delivers
    # (`get_by_artifact_id`), never by an id derived from that artifact.
    app = MicroApp(
        name=artifact.name,
        location_type=AppLocationType.Artifact,
        location_root=str(tmp_path / "dist"),
        artifact_id=artifact.id,
    )
    await app.save()
    return app


@pytest.mark.asyncio
async def test_dev_server_wins_when_one_is_running(bootstrapped_client, user, tmp_path):
    """Both runtimes present → the live dev server is what the user is working on."""
    artifact = await _artifact()
    await _dev(artifact, 3300)
    micro_app = await _micro_app(artifact, tmp_path)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["kind"] == DisplayTargetKind.APP
    assert target["artifact_id"] == artifact.id
    assert target["name"] == "Todo"
    assert target["runtime"] == "dev"
    assert target["port"] == 3300
    # The served route is still advertised, so the display can offer the switch.
    assert target["micro_app_id"] == micro_app.id


@pytest.mark.asyncio
async def test_served_when_there_is_no_dev_server(bootstrapped_client, user, tmp_path):
    artifact = await _artifact("Served only")
    micro_app = await _micro_app(artifact, tmp_path)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "served"
    assert target["micro_app_id"] == micro_app.id
    assert "port" not in target


@pytest.mark.asyncio
async def test_unbuilt_app_still_resolves(bootstrapped_client, user, tmp_path):
    """An app with neither runtime is addressable — that is what lets the
    display say "not built yet" instead of showing nothing at all."""
    artifact = await _artifact("Nothing yet")

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "unbuilt"
    assert target["artifact_id"] == artifact.id


@pytest.mark.asyncio
async def test_a_port_label_no_longer_claims_dev(bootstrapped_client, user, tmp_path):
    """The port is what the placement's `proxy` endpoint says — a label on the
    Deployment (how rows were written before endpoints) is not read at all."""
    artifact = await _artifact("Old label")
    deployment = await _deployment(artifact)
    deployment.provider_labels = {"flowpad.runtime.port": "3300"}
    await deployment.save(notify=False)
    await _micro_app(artifact, tmp_path)

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "served"


@pytest.mark.asyncio
async def test_a_static_endpoint_is_the_served_runtime(bootstrapped_client, user, tmp_path):
    artifact = await _artifact("Built")
    await _endpoint(artifact, await _deployment(artifact), {"type": "static", "root": str(tmp_path)})

    target = await resolve_display_target(artifact_id=artifact.id)

    assert target["runtime"] == "served"
    assert "port" not in target and "micro_app_id" not in target


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
async def test_port_addressing_still_works(bootstrapped_client, user):
    """`flow show webapp --port N` keeps addressing an entity-less dev server."""
    target = await resolve_display_target(port=4321)

    assert target == {"kind": DisplayTargetKind.WEBAPP, "port": 4321}
