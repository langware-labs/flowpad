"""Deleting a cloud deployment waits for the hub to delete its machine.

The hub tears a placement's machine down before it answers its DELETE — about two minutes for a
GCP VM on staging. The desktop asked with the hub's 10 s default, so the delete read "Can't reach
the hub right now" while the hub went on deleting: the row stayed here, and whoever deleted it was
told the machine might still be running. Only the hub call is replaced.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.team import Team
from flow_sdk.cloud_client.hub_proxy import DEFAULT_TIMEOUT, DEPLOY_TIMEOUT, HubProxy

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.fixture()
def hub(monkeypatch):
    """Records the timeout each hub DELETE was sent with (the default when none is given)."""
    sent: list[object] = []

    async def send(method, url, *, timeout=DEFAULT_TIMEOUT, **_kwargs):
        sent.append(timeout)
        return httpx.Response(200, request=httpx.Request(method, str(url)))

    monkeypatch.setattr(HubProxy, "send", send)
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials", lambda: SimpleNamespace(api_key="fp_test")
    )
    return sent


@pytest.mark.asyncio
async def test_a_deployment_delete_gets_the_deploy_budget(hub):
    row = Deployment.model_construct(id="0b1e5c1e-0000-4000-8000-000000000001", remote=True)

    await row.unshare(recursive=False)

    assert hub == [DEPLOY_TIMEOUT]
    assert row.remote is False


@pytest.mark.asyncio
async def test_other_rows_keep_the_hub_default(hub):
    row = Team.model_construct(id="0b1e5c1e-0000-4000-8000-000000000002", remote=True)

    await row.unshare(recursive=False)

    assert hub == [DEFAULT_TIMEOUT]
