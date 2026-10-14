"""The direct ingress is real HTTP, without opening the node's trusted API."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from flow_sdk.server import webhook_listener

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


async def test_direct_listener_is_narrow_and_keeps_port_across_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(webhook_listener, "_state_path", lambda: tmp_path / "listener.json")
    monkeypatch.setattr(webhook_listener, "_lock", asyncio.Lock())
    for key in ("FLOWPAD_WEBHOOK_HOST", "FLOWPAD_WEBHOOK_BASE_URL", "FLOWPAD_WEBHOOK_PORT"):
        monkeypatch.delenv(key, raising=False)
    assert await webhook_listener.callback_base_url() is None
    try:
        base = await webhook_listener.callback_base_url(start=True)
        assert base.startswith("http://127.0.0.1:")
        async with httpx.AsyncClient(base_url=base) as client:
            for path in ("/api/v1/graph/bootstrap", "/docs", "/openapi.json", "/api/v1/data_source/fake/webhook"):
                assert (await client.post(path)).status_code == 404
            assert (await client.get("/api/v1/data_source/webhook/nonexistent")).status_code == 404
        await webhook_listener.stop()
        assert await webhook_listener.callback_base_url() is None
        await webhook_listener.restore()
        assert await webhook_listener.callback_base_url() == base
    finally:
        await webhook_listener.stop()


async def test_nonloopback_requires_an_explicit_callback_origin(tmp_path, monkeypatch):
    monkeypatch.setattr(webhook_listener, "_state_path", lambda: tmp_path / "listener.json")
    monkeypatch.setattr(webhook_listener, "_lock", asyncio.Lock())
    monkeypatch.setenv("FLOWPAD_WEBHOOK_HOST", "0.0.0.0")
    monkeypatch.delenv("FLOWPAD_WEBHOOK_BASE_URL", raising=False)
    with pytest.raises(ValueError, match="requires FLOWPAD_WEBHOOK_BASE_URL"):
        await webhook_listener.callback_base_url(start=True)


async def test_main_api_gate_still_covers_provider_and_hub_paths(monkeypatch):
    from fastapi import FastAPI

    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.instance_settings import cookie_gate
    from flow_sdk.server.middleware import cookie_gate_middleware
    from flow_sdk.server.routes.data_source_webhook import router

    source_id = mint_uuid()
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(cookie_gate_middleware.CookieGateMiddleware)
    monkeypatch.setenv(cookie_gate_middleware.OFF_SWITCH_ENV, "on")
    monkeypatch.setattr(cookie_gate, "get_cookie_gate", lambda: "node-private-key")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://node.test") as client:
        for path in ("/api/v1/data_source/webhook/test", f"/api/v1/data_source/{source_id}/webhook"):
            assert (await client.post(path, json={})).status_code == 403
        response = await client.post(
            f"/api/v1/data_source/{source_id}/webhook", json={}, headers={"x-cookie-gate": "node-private-key"}
        )
        assert response.status_code == 404
