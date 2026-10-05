"""``llm_endpoint/<id>/models`` on the desk is a relay to the hub: GET only, status preserved."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.actions import action
from flow_sdk.app.actions import llm_endpoint_models_action as mod
from flow_sdk.cloud_client.shared.errors import HubError

ENDPOINT_ID = "a8473a10-74e5-4ce1-9fda-2babd551a399"
MODELS = [{"id": "anthropic/claude-haiku-4.5", "root_id": "llm_endpoint-root"}]


def _req(method="GET", endpoint_id=ENDPOINT_ID):
    target = SimpleNamespace(type="llm_endpoint", id=endpoint_id) if endpoint_id else None
    return SimpleNamespace(method=method, target_entity_typeid=target)


def test_registered_for_an_endpoint_the_desk_holds_no_row_for():
    registered = action.get_by_name("models", "llm_endpoint")
    assert registered is not None
    assert registered.allow_missing_target is True


@pytest.mark.asyncio
async def test_forwards_the_hub_model_list():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req()),
        patch.object(mod, "hub_base_url", return_value="https://hub.test"),
        patch.object(mod, "hub_get_or_raise", AsyncMock(return_value=MODELS)) as get,
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status == "SUCCESS"
    assert resp.data == MODELS
    get.assert_awaited_once_with("llm_endpoint", ENDPOINT_ID, action="models")


@pytest.mark.asyncio
async def test_hub_status_is_preserved():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req()),
        patch.object(mod, "hub_base_url", return_value="https://hub.test"),
        patch.object(mod, "hub_get_or_raise", AsyncMock(side_effect=HubError(403, "not yours"))),
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status == "FAIL"
    assert resp.status_code == 403
    assert resp.message == "not yours"


@pytest.mark.asyncio
async def test_unreachable_hub_is_502():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req()),
        patch.object(mod, "hub_base_url", return_value="https://hub.test"),
        patch.object(mod, "hub_get_or_raise", AsyncMock(side_effect=HubError(0, "connection refused"))),
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_no_hub_configured_is_an_explicit_409():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req()),
        patch.object(mod, "hub_base_url", return_value=None),
        patch.object(mod, "hub_get_or_raise", AsyncMock()) as get,
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status_code == 409
    get.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE"])
async def test_only_the_read_is_relayed(method):
    with (
        patch.object(mod, "get_current_request_info", return_value=_req(method=method)),
        patch.object(mod, "hub_base_url", return_value="https://hub.test"),
        patch.object(mod, "hub_get_or_raise", AsyncMock()) as get,
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status_code == 405
    get.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_endpoint_id_is_required():
    with (
        patch.object(mod, "get_current_request_info", return_value=_req(endpoint_id=None)),
        patch.object(mod, "hub_get_or_raise", AsyncMock()) as get,
    ):
        resp = await mod.llm_endpoint_models()
    assert resp.status_code == 400
    get.assert_not_awaited()
