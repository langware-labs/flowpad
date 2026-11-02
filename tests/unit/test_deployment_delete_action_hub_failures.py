"""``DELETE /graph/deployment/<id>`` passes on the hub's status instead of a blanket 502.

A remote placement is deleted on the hub first (``owns_hub_delete``). The delete action
(``handle_delete_by_id``) tells the two failures apart:

* the hub answered (an app failure): its own status, e.g. 403 for a deployment it no longer has;
* nothing came back (a connection failure: timeout, refused): 502;
* not signed in here: 401.

In every failure the local row is kept as the handle to retry. The hub is faked at the HTTP transport,
so the real ``HubProxy.send`` turns a hang into a ``HubError``. No network.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException

from flow_sdk.app.actions.graph_crud_actions import handle_delete_by_id
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.responses.response import ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval

TARGET_NOT_FOUND = {
    "status": "FAIL",
    "message": "Missing request info(Target entity not found)",
    "data": {"error_code": "target_not_found"},
}
UNAUTHENTICATED = {"status": "FAIL", "message": "Forbidden access", "data": {"error_code": "unauthenticated"}}
SERVER_ERROR = {"status": "FAIL", "message": "An unexpected error occurred. Please try again later."}


@pytest.fixture
def hub(monkeypatch):
    """The hub behind the real ``HubProxy.send``: ``answer`` is a response, or an exception to raise."""
    from flow_sdk.cli.auth import credentials
    from flow_sdk.cloud_client import hub_proxy
    from flow_sdk.cloud_client.transport import hub_http

    state = SimpleNamespace(answer=httpx.Response(200), calls=[])

    def handle(request: httpx.Request) -> httpx.Response:
        state.calls.append((request.method, str(request.url)))
        if isinstance(state.answer, Exception):
            raise state.answer
        return state.answer

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))

    @asynccontextmanager
    async def fake_hub_client():
        async def get_client():
            return client

        yield SimpleNamespace(_get_client=get_client)

    async def no_report(*args, **kwargs):
        return None

    monkeypatch.setattr(hub_http, "_hub_client", fake_hub_client)
    # Process-wide reachability bookkeeping: kept out of the other tests.
    monkeypatch.setattr(hub_proxy, "_note_reach", lambda status: None)
    monkeypatch.setattr(hub_proxy, "_report_unreachable", no_report)
    monkeypatch.setattr(credentials, "load_credentials", lambda: SimpleNamespace(api_key="test-key"))
    return state


async def _remote_placement() -> Deployment:
    row = Deployment(
        name="delete-action-test",
        parent_type_id="agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d",
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
    )
    row.remote = True
    await row.save()
    return row


async def _delete(row: Deployment):
    """``DELETE /graph/deployment/<id>`` through the delete action."""
    request = SimpleNamespace(target_entity_typeid=row.typeid)
    with patch("flow_sdk.app.actions.graph_crud_actions.get_current_request_info", return_value=request), patch(
        "flow_sdk.request_context.methods.get_current_request_info", return_value=request
    ):
        return await handle_delete_by_id()


async def _refused(row: Deployment) -> HTTPException:
    """The delete fails; the local row stays as the handle to retry."""
    with pytest.raises(HTTPException) as refused:
        await _delete(row)
    assert "kept here so the delete can be retried" in refused.value.detail
    assert await Deployment.get_by_id(row.id) is not None, "the handle to retry"
    return refused.value


async def test_the_hub_deletes_it(hub):
    row = await _remote_placement()

    answer = await _delete(row)

    assert isinstance(answer, ApiSuccessResponse) and answer.data is True
    assert [m for m, _ in hub.calls] == ["DELETE"] and row.id in hub.calls[0][1]
    assert await Deployment.get_by_id(row.id) is None


async def test_already_gone_on_the_hub_is_deleted_here(hub):
    hub.answer = httpx.Response(404)
    row = await _remote_placement()

    answer = await _delete(row)

    assert isinstance(answer, ApiSuccessResponse)
    assert await Deployment.get_by_id(row.id) is None


async def test_a_deployment_the_hub_no_longer_has_answers_its_403(hub):
    """The live case: the hub's row (and its machine) is gone, and its authorizer answers 403 target_not_found."""
    hub.answer = httpx.Response(403, json=TARGET_NOT_FOUND)
    row = await _remote_placement()

    assert (await _refused(row)).status_code == 403


async def test_the_hub_failing_to_destroy_the_machine_answers_its_500(hub):
    """The hub answered, so it is an app failure: passed on, not turned into a gateway error."""
    hub.answer = httpx.Response(500, json=SERVER_ERROR)
    row = await _remote_placement()

    assert (await _refused(row)).status_code == 500


@pytest.mark.parametrize(
    "failure",
    [httpx.ReadTimeout("the hub never answered"), httpx.ConnectError("connection refused")],
    ids=["hub-hangs", "hub-unreachable"],
)
async def test_a_hub_that_does_not_answer_is_a_502(hub, failure):
    hub.answer = failure
    row = await _remote_placement()

    assert (await _refused(row)).status_code == 502


async def test_a_credential_the_hub_rejects_answers_its_401(hub):
    hub.answer = httpx.Response(401, json=UNAUTHENTICATED)
    row = await _remote_placement()

    assert (await _refused(row)).status_code == 401


async def test_no_credentials_here_is_a_401_and_never_asks_the_hub(hub, monkeypatch):
    from flow_sdk.cli.auth import credentials

    monkeypatch.setattr(credentials, "load_credentials", lambda: None)
    row = await _remote_placement()

    assert (await _refused(row)).status_code == 401
    assert hub.calls == []
