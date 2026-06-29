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


@pytest.mark.asyncio
async def test_capabilities_summary_groups_by_intent(bootstrapped_client):
    response = await bootstrapped_client.get("/api/v1/graph/capabilities/summary")

    assert response.status_code == 200, response.text
    summary = response.json()
    intents = {group["intent"] for group in summary["intents"]}
    assert CapabilityKind.HARNESS.value in intents  # "harness"
    kinds = {cap["kind"] for cap in summary["capabilities"]}
    assert CapabilityKind.CLAUDE_CLI.value in kinds
    # Every capability carries its intent (segment-1 handle) and a runnable flag.
    claude = next(c for c in summary["capabilities"] if c["kind"] == CapabilityKind.CLAUDE_CLI.value)
    assert claude["intent"] == CapabilityKind.HARNESS.value
    assert "runnable" in claude and "installable" in claude


@pytest.mark.asyncio
async def test_install_intent_launches_setup_agent(bootstrapped_client, monkeypatch):
    import flow_sdk.server.routes.capabilities as routes_mod
    from flow_sdk.core.capabilities.models import CapabilityResult

    captured = {}

    async def _fake_intent(text):
        captured["text"] = text
        return CapabilityResult(ok=True, available=False, message="started", process_id="pid-xyz")

    monkeypatch.setattr(routes_mod, "run_capability_install_for_intent", _fake_intent)

    response = await bootstrapped_client.post(
        "/api/v1/graph/capabilities/install-intent", json={"text": "I want email"}
    )

    assert response.status_code == 200, response.text
    assert captured["text"] == "I want email"
    assert response.json()["process_id"] == "pid-xyz"
