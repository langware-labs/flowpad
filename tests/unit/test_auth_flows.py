"""Pins for the one authorization-flow registry (`flow_sdk/core/oauth/flows.py`)."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.app.actions.oauth_templates import landing_page
from flow_sdk.core.oauth import flows
from flow_sdk.core.oauth.flows import AuthFlowKind, AuthFlowResult, AuthFlowStatus
from tests.utils.oauth_flow_doubles import connect_tab, reset_flow_registry

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    return reset_flow_registry(monkeypatch)


_connect = connect_tab


def _ok(provider="slack", identity="me"):
    return AuthFlowResult(status=AuthFlowStatus.SUCCESS, provider=provider, identity=identity)


async def test_only_the_initiating_tab_is_told(isolated):
    initiator, bystander = _connect(isolated, "tab-a"), _connect(isolated, "tab-b")
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack", initiator_connection_id="tab-a")

    assert await flows.finish_flow(flow.flow_id, _ok()) is True

    assert [m["oauth_request_id"] for m in initiator.sent] == [flow.flow_id]
    assert initiator.sent[0]["status"] == "success" and initiator.sent[0]["identity"] == "me"
    assert bystander.sent == []


async def test_first_result_wins_and_is_sent_once(isolated):
    initiator = _connect(isolated, "tab-a")
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack", initiator_connection_id="tab-a")

    await flows.finish_flow(flow.flow_id, _ok())
    await flows.finish_flow(flow.flow_id, AuthFlowResult(status=AuthFlowStatus.ERROR, provider="slack"))

    assert flows.get_flow(flow.flow_id).result.status is AuthFlowStatus.SUCCESS
    assert len(initiator.sent) == 1


async def test_a_parked_cli_waiter_is_an_initiator():
    flow = flows.start_flow(AuthFlowKind.LOOPBACK, "linear")
    waiter = asyncio.create_task(flows.wait_flow(flow.flow_id))
    await asyncio.sleep(0)

    assert await flows.finish_flow(flow.flow_id, _ok("linear")) is True
    assert (await waiter).provider == "linear"


async def test_nobody_left_to_tell_is_not_delivered():
    flow = flows.start_flow(AuthFlowKind.HUB_CODE, "slack", initiator_connection_id="closed-tab")

    assert await flows.finish_flow(flow.flow_id, _ok()) is False


async def test_an_unknown_flow_is_neither_waited_on_nor_delivered():
    assert await flows.wait_flow("never-started") is None
    assert await flows.finish_flow("never-started", _ok()) is False


def test_landing_closes_when_delivered_and_confirms_when_not():
    closing = landing_page(_ok(), delivered=True).body.decode()
    confirming = landing_page(_ok(), delivered=False).body.decode()

    assert "window.close()" in closing and "connected" not in closing
    assert "slack connected" in confirming and "as me" in confirming
    assert landing_page(AuthFlowResult(status=AuthFlowStatus.ERROR, provider="x"), False).status_code == 400
    assert landing_page(None, delivered=True).status_code == 404
