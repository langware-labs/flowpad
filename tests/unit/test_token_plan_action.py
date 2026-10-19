"""``token_plan`` on the desk is a read-through to the hub: status preserved, only ``me``."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import token_plan_action as mod
from flow_sdk.cloud_client.shared.errors import HubError

PLAN = {"as_of": 1, "scopes": [{"kind": "me", "id": "u1"}]}


def _req(sub_path):
    return SimpleNamespace(sub_path=sub_path)


@pytest.mark.asyncio
async def test_me_forwards_the_hub_plan():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req("me")),
        patch.object(mod, "hub_get_or_raise", AsyncMock(return_value=PLAN)) as get,
    ):
        resp = await mod.token_plan_action()
    assert resp.status == "SUCCESS"
    assert resp.data == PLAN
    get.assert_awaited_once_with("token_plan", action="me")


@pytest.mark.asyncio
async def test_hub_status_is_preserved():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req("/me")),
        patch.object(mod, "hub_get_or_raise", AsyncMock(side_effect=HubError(403, "signed out"))),
    ):
        resp = await mod.token_plan_action()
    assert resp.status == "FAIL"
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_unreachable_hub_is_503():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req("me")),
        patch.object(mod, "hub_get_or_raise", AsyncMock(side_effect=HubError(0, "hub not configured"))),
    ):
        resp = await mod.token_plan_action()
    assert resp.status == "FAIL"
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_setup_routes_are_not_proxied():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req("org/setup")),
        patch.object(mod, "hub_get_or_raise", AsyncMock()) as get,
    ):
        resp = await mod.token_plan_action()
    assert resp.status == "FAIL"
    assert resp.status_code == 404
    get.assert_not_awaited()
