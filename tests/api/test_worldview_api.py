from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.responses.response import ApiResponse
from flow_sdk.worldview.models import (
    DeploymentTarget,
    InventoryOrganization,
    InventorySnapshot,
    OrganizationInventory,
)

pytestmark = pytest.mark.asyncio


async def test_worldview_load_and_manual_link_use_standard_envelopes(client):
    artifact = Artifact(id=mint_uuid(), name="API artifact", kind="application.web")
    deployment = Deployment(
        id=mint_uuid(),
        name="API deployment",
        kind="local.runtime",
        target=DeploymentTarget(provider="local", scope="machine"),
    )
    await artifact.save(notify=False)
    await deployment.save(notify=False)

    linked = await client.post(
        f"/api/v1/graph/deployment/{deployment.id}/link-artifact",
        json={"artifact_id": artifact.id},
    )
    linked_body = ApiResponse(**linked.json())
    assert linked_body.status == "SUCCESS"
    assert linked_body.data["artifact_link_source"] == "manual"

    loaded = await client.get("/api/v1/worldview")
    loaded_body = ApiResponse(**loaded.json())
    assert loaded_body.status == "SUCCESS"
    assert loaded_body.data["counts"]["nodes"] == len(loaded_body.data["nodes"])
    assert any(edge["kind"] == "deployed_as" for edge in loaded_body.data["edges"])


async def test_worldview_link_validation_uses_fail_envelope_and_http_400(client):
    invalid = await client.post(
        "/api/v1/graph/deployment/not-an-id/link-artifact",
        json={"artifact_id": "also-not-an-id"},
    )
    invalid_body = ApiResponse(**invalid.json())
    assert invalid.status_code == 400
    assert invalid_body.status == "FAIL"
    assert "UUID v4 or v5" in invalid_body.message

    missing = await client.post(
        f"/api/v1/graph/deployment/{mint_uuid()}/link-artifact",
        json={"artifact_id": mint_uuid()},
    )
    missing_body = ApiResponse(**missing.json())
    assert missing.status_code == 404
    assert missing_body.status == "FAIL"
    assert missing_body.message.startswith("Entity not found: deployment/")


async def test_worldview_sync_endpoint_accepts_a_fake_read_only_provider(client, monkeypatch):
    import flow_sdk.server.routes.worldview as route_module
    from flow_sdk.worldview.service import sync_worldview as sync_with

    class FakeProvider:
        name = "gcp"

        async def collect(self):
            return InventorySnapshot(
                provider="gcp",
                observed_at="2026-07-18T13:00:00Z",
                organizations=[
                    OrganizationInventory(
                        organization=InventoryOrganization(
                            id="api-fake-org",
                            name="API Fake Org",
                            full_resource_name=(
                                "//cloudresourcemanager.googleapis.com/organizations/api-fake-org"
                            ),
                        )
                    )
                ],
            )

    async def fake_sync():
        return await sync_with(FakeProvider())

    monkeypatch.setattr(route_module, "sync_worldview", fake_sync)
    response = await client.post("/api/v1/worldview/sync")
    body = ApiResponse(**response.json())
    assert body.status == "SUCCESS"
    assert body.data["sync"]["organizations_succeeded"] == 1
    assert body.data["root"].startswith("deployment-")
