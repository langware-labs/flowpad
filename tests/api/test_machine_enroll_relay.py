"""The desktop's ``machine-enroll`` relay: routes exist, ops are validated, hub-offline is explicit."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize("op", ["lookup", "approve", "deny"])
async def test_relay_is_registered_for_every_op(client, op, monkeypatch):
    # No hub configured → a clear 409 rather than a stack trace or a 422 "unknown action".
    from flow_sdk.app.actions import machine_enroll_action

    monkeypatch.setattr(machine_enroll_action, "hub_base_url", lambda: None)
    resp = await client.post(f"/api/v1/graph/machine-enroll/{op}", json={"user_code": "WDJB-MJHT"})
    assert resp.status_code == 409, resp.text
    assert "Sign in to the hub" in resp.json()["message"]


async def test_relay_refuses_unknown_ops_and_bad_bodies(client):
    resp = await client.post("/api/v1/graph/machine-enroll/format-disk", json={"user_code": "X"})
    assert resp.status_code == 404
    resp = await client.post("/api/v1/graph/machine-enroll/lookup", json=["not", "a", "dict"])
    assert resp.status_code == 400
