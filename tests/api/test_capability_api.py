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
async def test_capability_test_action_returns_available_bool(bootstrapped_client, monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/usr/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )
    capability_id = capability_id_for_kind(CapabilityKind.CLAUDE_CLI.value)

    response = await bootstrapped_client.post(f"/api/v1/graph/capability/{capability_id}/test")

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["kind"] == CapabilityKind.CLAUDE_CLI.value
    assert data["result"]["available"] is True


@pytest.mark.asyncio
async def test_capabilities_summary_groups_by_intent(bootstrapped_client):
    response = await bootstrapped_client.get("/api/v1/graph/capabilities/summary")

    assert response.status_code == 200, response.text
    summary = response.json()["data"]
    intents = {group["intent"] for group in summary["intents"]}
    assert CapabilityKind.HARNESS.value in intents  # "harness"
    kinds = {cap["kind"] for cap in summary["capabilities"]}
    assert CapabilityKind.CLAUDE_CLI.value in kinds
    # Every capability carries its intent (segment-1 handle) and a runnable flag.
    claude = next(c for c in summary["capabilities"] if c["kind"] == CapabilityKind.CLAUDE_CLI.value)
    assert claude["intent"] == CapabilityKind.HARNESS.value
    assert "runnable" in claude and "installable" in claude


@pytest.mark.asyncio
async def test_setup_intent_launches_setup_agent(bootstrapped_client, monkeypatch):
    import flow_sdk.server.routes.capabilities as routes_mod
    from flow_sdk.core.capabilities.models import CapabilityResult

    captured = {}

    async def _fake_intent(text):
        captured["text"] = text
        return CapabilityResult(ok=True, available=False, message="started", process_id="pid-xyz")

    monkeypatch.setattr(routes_mod, "run_capability_install_for_intent", _fake_intent)

    response = await bootstrapped_client.post("/api/v1/graph/capabilities/setup-intent", json={"text": "I want email"})

    assert response.status_code == 200, response.text
    assert captured["text"] == "I want email"
    assert response.json()["data"]["process_id"] == "pid-xyz"


@pytest.mark.asyncio
async def test_scoped_capability_test_answers_in_the_api_envelope(bootstrapped_client, monkeypatch):
    """The project share/invite gate reads this through `apiClient`, which unwraps
    `data`. A bare payload here reads back as `undefined` in the browser and the
    gate blocks every project — so the envelope is part of the contract."""
    import flow_sdk.server.routes.capabilities as routes_mod
    from flow_sdk.core.capabilities.models import CapabilityCheck, CapabilityResult

    async def _fake_test(kind, scope=None):
        return CapabilityCheck(
            kind=kind,
            result=CapabilityResult(
                ok=False,
                available=False,
                message="Project has no Git repository and remote.",
                details={"reason": "no-git-remote"},
            ),
        )

    monkeypatch.setattr(routes_mod.get_capability_registry(), "test", _fake_test)

    response = await bootstrapped_client.post(
        "/api/v1/graph/capabilities/test",
        json={
            "kind": CapabilityKind.GITHUB.value,
            "scope_type": "project",
            "scope_id": "11317f4e-ca67-58aa-b06c-4c5a39a16844",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS"
    check = body["data"]
    assert check["result"]["available"] is False
    assert check["result"]["details"]["reason"] == "no-git-remote"
