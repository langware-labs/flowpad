"""The local backend relays a REMOTE deployment's process actions to the hub.

Mirror of the hub's own ``test_deployed_agent_chat_proxy.py`` one tier up: a
session opened on a placement that is not on this machine goes through the hub
(``Deployment._use_on_hub``), the process is adopted AT THE HUB'S ID as a route
row (``AgenticProcess.adopt_route``), and every process action on that row
forwards — SDK bodies unchanged, streams verbatim through ``CloudProxy``, the
projection re-read afterwards so the local WS ``data_op`` fires for the chat
panel. Verbs that only make sense next to the worker refuse with 409.

The hub is faked at the two seams the relay uses: the shared hub verbs
(``hub_http.hub_get/hub_post/hub_delete``) and the request proxy. No network.
"""

import uuid
from unittest.mock import AsyncMock

import pytest
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.process_lifecycle import ProcessStatus
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROCESS_ID = "94a0f167-25db-40d3-8ef9-c699a349d79d"
DESCRIPTOR = {
    "id": PROCESS_ID,
    "status": ProcessStatus.RUNNING.value,
    "session_id": "hub-session-1",
    "busy": False,
    "worker_status": "complete",
    "ready_for_input": True,
    "queue": {"enabled": True, "entries": []},
    "total_cost_usd": 0.07,
}


class _FakeHub:
    """Records every hub call; answers the way the hub's route class does."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.fail = False
        self.streams_open = 0
        self.stream_status = 200

    async def post(self, etype, payload, eid=None, action=None, **_):
        self.calls.append(("POST", etype, eid, action, payload))
        if self.fail:
            raise HubError(0, "hub said no")
        if action == "use":
            return {"process_id": PROCESS_ID, "process_typeid": f"agentic_process-{PROCESS_ID}"}
        return {"relayed": action, "echo": payload}

    async def get(self, etype, eid=None, action=None, **_):
        self.calls.append(("GET", etype, eid, action, None))
        if self.fail:
            return None
        return dict(DESCRIPTOR) if action is None else {"relayed": action}

    async def delete(self, etype, eid, action=None, **_):
        self.calls.append(("DELETE", etype, eid, action, None))
        if self.fail:
            raise HubError(0, "box unreachable")
        return {"deleted": True}

    async def proxy(self, request, url):  # bound in place of CloudProxy.__call__
        self.calls.append(("STREAM", url))
        self.streams_open += 1

        async def _chunks():
            yield b'{"type":"text","text":"PO"}\n'
            yield b'{"type":"text","text":"NG"}\n'

        async def _close():
            self.streams_open -= 1

        return StreamingResponse(
            _chunks(),
            status_code=self.stream_status,
            headers={"content-type": "text/event-stream"},
            background=BackgroundTask(_close),
        )


@pytest.fixture
def hub(monkeypatch):
    fake = _FakeHub()
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake.post)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake.get)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_delete", fake.delete)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.proxy.CloudProxy.__call__", fake.proxy)
    return fake


def _request(body: dict, monkeypatch, *, someone="user-11111111-1111-4111-8111-111111111111") -> RequestInfo:
    """A real RequestInfo (the entity layer reads a dozen of its attributes on
    every get/save) carrying just a body, a human, and a Starlette request."""
    info = RequestInfo()
    info.get_post_data = AsyncMock(return_value=body)
    info.request = object()  # only its presence matters to the relay
    monkeypatch.setattr(type(info), "someone_typeid", property(lambda self: someone))
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info", lambda: info)
    monkeypatch.setattr("flow_sdk.request_context.methods.get_current_request_info", lambda: info)
    return info


async def _agent(name="relay-agent") -> Agent:
    a = Agent(name=name, system_prompt="relay me", worker_type="claude", model="haiku")
    await a.save()
    return a


async def _remote_placement(agent: Agent):
    there = await agent.deploy("e2b")
    assert there.is_local is False
    return there


async def _route(hub) -> AgenticProcess:
    agent = await _agent(f"route-{uuid.uuid4().hex[:6]}")
    route = await agent.use(deployment=await _remote_placement(agent))
    hub.calls.clear()
    return route


# ── use ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_use_on_a_remote_placement_adopts_the_hubs_process_at_its_id(hub):
    agent = await _agent()
    there = await _remote_placement(agent)

    route = await agent.use(deployment=there)

    assert hub.calls[0] == ("POST", "agent", agent.id, "use", {"deployment_id": there.id})
    assert route.id == PROCESS_ID and route.hub_route is True and route.remote is True
    assert route.deployment_id == there.id and route.target_typeid_str == str(agent.typeid)
    assert route.process_type == "chat" and route.pty_mode is False and route.visible is True
    assert route.status == ProcessStatus.RUNNING.value and route.session_id == "hub-session-1"
    assert (await AgenticProcess.get_by_id(PROCESS_ID)).model_dump(mode="json")["total_cost_usd"] == 0.07


@pytest.mark.asyncio
async def test_use_action_selects_the_exact_deployment_and_rejects_a_foreign_one(hub, monkeypatch):
    agent = await _agent("select-agent")
    there = await _remote_placement(agent)
    theirs = await _remote_placement(await _agent("stranger-agent"))

    _request({"deployment_id": there.id}, monkeypatch)
    ok = await agent.use_action()
    assert isinstance(ok, ApiSuccessResponse), ok
    assert ok.data["process_id"] == PROCESS_ID and ok.data["deployment_id"] == there.id

    _request({"deployment_id": theirs.id}, monkeypatch)
    assert (await agent.use_action()).status_code == 404
    _request({"deployment_id": "not-a-uuid"}, monkeypatch)
    assert (await agent.use_action()).status_code == 400
    assert [c for c in hub.calls if c[0] == "POST" and c[3] == "use"] == [
        ("POST", "agent", agent.id, "use", {"deployment_id": there.id})
    ]


# ── relayed actions ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_queue_actions_relay_the_sdk_bodies_unchanged(hub, monkeypatch):
    route = await _route(hub)
    for method, body in (
        (route._enqueue_action, {"prompt": "later", "source": "ui"}),
        (route._dequeue_action, {"id": "q-1"}),
        (route._set_queue_enabled_action, {"enabled": False}),
    ):
        _request(body, monkeypatch)
        result = await method()
        assert isinstance(result, ApiSuccessResponse), result
        assert result.data["echo"] == body
        assert ("POST", "agentic_process", route.id, result.data["relayed"], body) in hub.calls
    assert (await route._clear_queue_action()).data["relayed"] == "clear-queue"
    # every mutating relay re-reads the projection so the local row broadcasts
    assert hub.calls.count(("GET", "agentic_process", route.id, None, None)) == 4


@pytest.mark.asyncio
async def test_reads_and_terminal_verbs_relay_without_a_projection_round_trip(hub):
    route = await _route(hub)
    assert (await route.get_history_action()).data == {"relayed": "get-history"}
    assert (await route._http_cancel_prompt()).data["relayed"] == "cancel-prompt"
    assert (await route.exit()).data["relayed"] == "exit"
    assert ("GET", "agentic_process", route.id, None, None) in hub.calls  # cancel-prompt refreshes
    assert hub.calls.count(("GET", "agentic_process", route.id, None, None)) == 1


@pytest.mark.asyncio
async def test_status_relay_is_itself_the_projection(hub, monkeypatch):
    route = await _route(hub)
    monkeypatch.setattr(
        "flow_sdk.cloud_client.transport.hub_http.hub_get",
        AsyncMock(return_value={"status": "running", "busy": True, "worker_status": "working"}),
    )
    result = await route.get_status()
    assert result.data["busy"] is True
    assert (await AgenticProcess.get_by_id(route.id)).model_dump(mode="json")["worker_status"] == "working"


@pytest.mark.asyncio
async def test_prompt_streams_through_the_proxy_and_marks_busy_only_while_open(hub, monkeypatch):
    route = await _route(hub)
    _request({"message": "Reply with PONG"}, monkeypatch)

    response = await route._http_prompt()
    assert isinstance(response, StreamingResponse), response
    assert hub.calls[-1][0] == "STREAM" and hub.calls[-1][1].endswith(f"/agentic_process/{route.id}/prompt")
    assert (await AgenticProcess.get_by_id(route.id)).model_dump(mode="json")["busy"] is True
    assert hub.streams_open == 1

    chunks = [chunk async for chunk in response.body_iterator]
    assert b"".join(chunks) == b'{"type":"text","text":"PO"}\n{"type":"text","text":"NG"}\n'
    await response.background()  # what Starlette runs once the response is done, disconnects included
    assert hub.streams_open == 0
    assert (await AgenticProcess.get_by_id(route.id)).model_dump(mode="json")["busy"] is False


@pytest.mark.asyncio
async def test_transport_failure_is_a_service_error(hub):
    route = await _route(hub)
    hub.fail = True
    assert (await route._clear_queue_action()).status_code == 503
    assert (await route.get_history_action()).status_code == 503


@pytest.mark.asyncio
async def test_worker_side_verbs_refuse_on_a_route_row(hub):
    route = await _route(hub)
    for verb in (route._http_open, route.http_restart, route.http_self_restart, route._http_close, route._drain_queue_action):
        result = await verb()
        assert isinstance(result, ApiFailResponse) and result.status_code == 409, verb.__name__
    assert hub.calls == []


@pytest.mark.asyncio
async def test_os_status_answers_from_the_projection(hub):
    route = await _route(hub)
    data = (await route.os_status()).data
    assert data["ready"] is True and data["worker_alive"] is True and data["pty_alive"] is False
    assert data["remote"] is True and data["shell_id"] is None


@pytest.mark.asyncio
async def test_delete_removes_the_remote_process_first_and_keeps_the_row_on_failure(hub):
    route = await _route(hub)
    hub.fail = True
    with pytest.raises(RuntimeError):
        await route.delete()
    assert await AgenticProcess.get_by_id(route.id) is not None  # kept for retry

    hub.fail = False
    await route.delete()
    assert ("DELETE", "agentic_process", route.id, None, None) in hub.calls
    assert await AgenticProcess.get_by_id(route.id) is None
