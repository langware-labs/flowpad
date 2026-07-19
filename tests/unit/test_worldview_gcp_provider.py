from __future__ import annotations

import pytest

from flow_sdk.worldview.providers.base import InventoryProviderError
from flow_sdk.worldview.providers.gcp import GCPInventoryProvider


@pytest.mark.asyncio
async def test_gcp_provider_continues_after_one_organization_failure(monkeypatch):
    calls: list[list[str]] = []
    monkeypatch.setenv("FLOWPAD_GCP_BILLING_PROJECT", "inventory-billing")

    async def runner(args: list[str]):
        calls.append(args)
        if args[:2] == ["organizations", "list"]:
            return [
                {"name": "organizations/1", "displayName": "One"},
                {"name": "organizations/2", "displayName": "Two"},
            ]
        if "--scope=organizations/2" in args:
            raise InventoryProviderError("CAI denied")
        return [
            {
                "name": "//run.googleapis.com/projects/p/locations/us/services/web",
                "assetType": "run.googleapis.com/Service",
                "displayName": "web",
                "organization": "organizations/1",
                "project": "projects/10",
                "labels": {"team": "platform"},
                "state": "ACTIVE",
            }
        ]

    snapshot = await GCPInventoryProvider(runner).collect()
    assert len(snapshot.organizations) == 2
    assert snapshot.organizations[0].resources[0].name == "web"
    assert snapshot.organizations[1].error == "CAI denied"
    assert all(call[-1] == "--format=json" for call in calls)
    assert all("--quiet" in call for call in calls)
    assert "--billing-project=inventory-billing" not in calls[0]
    assert all("--billing-project=inventory-billing" in call for call in calls[1:])
    assert any(arg.startswith("--read-mask=") for arg in calls[1])
