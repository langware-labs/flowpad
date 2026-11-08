"""A deploy the hub refuses because a dependency cannot be fetched says which one and what to do -- not
"hub error 409". The hub's refusal carries ``data.dependencies``; the HubError keeps it and the deploy step
turns it into one sentence per blocked dependency."""
from __future__ import annotations

import httpx
import pytest

from flow_sdk.builtin.agent_cloud_deploy import dependency_blockers
from flow_sdk.cloud_client.hub_proxy import _unwrap
from flow_sdk.cloud_client.shared.errors import HubError

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

REFUSAL = {
    "status": "FAIL",
    "message": "Required project dependencies are not ready: waha",
    "data": {"dependencies": [
        {"name": "waha", "source": "git+https://github.com/langware-labs/waha-service.git", "required": True,
         "state": "unreachable", "reason": "private repo",
         "fix": "connect GitHub, or install the Flowpad GitHub App on langware-labs"},
        {"name": "site", "source": "git+https://github.com/langware-labs/sapak.git", "required": True,
         "state": "ready"},
        {"name": "notes", "source": "file:~/notes", "required": False, "state": "missing"},
    ]},
}


async def test_a_hub_refusal_keeps_its_data():
    resp = httpx.Response(409, json=REFUSAL, request=httpx.Request("POST", "https://hub.test/x"))
    with pytest.raises(HubError) as caught:
        _unwrap(resp, method="POST", url="https://hub.test/x")
    assert caught.value.status_code == 409
    assert caught.value.data == REFUSAL["data"]


async def test_dependency_blockers_name_each_required_unready_dependency_and_its_fix():
    assert dependency_blockers(REFUSAL["data"]) == [
        "waha: private repo — connect GitHub, or install the Flowpad GitHub App on langware-labs"
    ]


async def test_a_refusal_not_about_dependencies_has_no_blockers():
    assert dependency_blockers(None) == []
    assert dependency_blockers({"code": "git_origin_required"}) == []
    assert dependency_blockers({"dependencies": [{"name": "x", "required": True}]}) == ["x: not ready"]
