from __future__ import annotations

import pytest

from flow_sdk.builtin.capability import capability_id_for_kind
from flow_sdk.core.capabilities import CapabilityKind


@pytest.mark.asyncio
async def test_capabilities_are_seeded_as_system_entities(bootstrapped_client):
    response = await bootstrapped_client.get("/api/v1/graph/capability?include_system=true")

    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    kinds = {row["kind"] for row in rows}
    assert CapabilityKind.CLAUDE_CLI.value in kinds
    assert CapabilityKind.CODEX_CLI.value in kinds
    assert CapabilityKind.CHROME_AUTHENTICATED.value in kinds


@pytest.mark.asyncio
async def test_capability_check_action_returns_available_bool(bootstrapped_client, monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/usr/bin/{executable}")
    capability_id = capability_id_for_kind(CapabilityKind.CLAUDE_CLI.value)

    response = await bootstrapped_client.post(f"/api/v1/graph/capability/{capability_id}/check")

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["kind"] == CapabilityKind.CLAUDE_CLI.value
    assert data["result"]["available"] is True
