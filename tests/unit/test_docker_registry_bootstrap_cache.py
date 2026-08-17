from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.compute.providers.docker import docker_registry
from flow_sdk.server.routes import bootstrap


class _IdleWebSocket:
    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_registry_transitions_invalidate_bootstrap_provider_projection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    machine_id = "machine-provider-cache"
    monkeypatch.setattr(docker_registry.WorkerConn, "start_reader", lambda _self: None)
    docker_registry._workers.pop(machine_id, None)

    bootstrap._bootstrap_cache = SimpleNamespace(docker_available=False)
    docker_registry.register(machine_id, _IdleWebSocket(), "qa-container")
    assert bootstrap._bootstrap_cache is None

    bootstrap._bootstrap_cache = SimpleNamespace(docker_available=True)
    await docker_registry.unregister(machine_id)
    assert bootstrap._bootstrap_cache is None
