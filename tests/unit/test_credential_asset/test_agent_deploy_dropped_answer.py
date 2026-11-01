"""``POST /agent/<id>/deploy`` on ``gcp_vm`` while the load balancer in front of the hub kills the deploy request: the
action answers, the machine step waits on the placement's local row, and the hub's push of that placement — mirrored
by the bridge, announced on the bus — ends the deploy. The hub is the in-memory double; only its ``deploy`` goes out on
the real ``HubProxy``, to a wire that drops it. No network, no backend."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from flow_sdk.activity import ActivityState, monitor
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import DEPLOY_ACTIVITY, AgentDeployRequest
from flow_sdk.builtin.cloud_deploy import deploy_entity_to_cloud
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client import hub_proxy
from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.schema.data_spec.activity_spec import ActivityProgressSpec
from tests.utils import fake_hub_store

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DROPPED = "Server disconnected without sending a response."
OWNER = "user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


@pytest.fixture(autouse=True)
def _clean_monitor():
    monitor.clear()
    yield
    monitor.clear()


@pytest.fixture
def hub(monkeypatch):
    """The fake hub for every call but ``deploy``, which the real ``HubProxy`` sends to a wire that drops it the way
    the load balancer drops a request it held too long. ``hub.sent``: the deploy bodies; ``hub.dropped``: set once
    one was dropped."""
    real_call = HubProxy.call
    hub = fake_hub_store.install(monkeypatch)
    hub.sent, hub.dropped = [], asyncio.Event()

    async def call(method, etype, eid=None, action=None, sub_path=None, **kwargs):
        if action == "deploy":
            return await real_call(method, etype, eid, action, sub_path, **kwargs)
        return await hub.call(method, etype, eid, action, sub_path, **kwargs)

    def drop(request: httpx.Request) -> httpx.Response:
        hub.sent.append(json.loads(request.content))
        hub.dropped.set()
        raise httpx.RemoteProtocolError(DROPPED, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(drop))

    @contextlib.asynccontextmanager
    async def _hub_client():
        async def _get_client():
            return client

        yield SimpleNamespace(_get_client=_get_client)

    async def signed_in():
        return "token"

    async def unreported(**_):
        return None

    monkeypatch.setattr(HubProxy, "call", staticmethod(call))
    monkeypatch.setattr("flow_sdk.builtin.cloud_deploy.deploy_entity_to_cloud", deploy_entity_to_cloud)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http._hub_client", _hub_client)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http._hub_unreachable", False)  # the drop flips it
    monkeypatch.setattr(
        hub_proxy,
        "graph_url",
        lambda et, eid=None, action=None, sub=None, *, scope=None: (
            f"http://hub.test/api/v1/graph/{getattr(et, 'value', et)}/{eid}/{action}"
        ),
    )
    monkeypatch.setattr("flow_sdk.cloud_client.client_hooks.resolve_hub_credential", signed_in)
    monkeypatch.setattr("flow_sdk.cli.auth.credentials.load_credentials", lambda: SimpleNamespace(api_key="token"))
    monkeypatch.setattr("flow_sdk.cloud_client.error_reporter.hub_error_reporter.report", unreported)
    return hub


@pytest.fixture
async def agent(home, project, hub, monkeypatch) -> Agent:
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)  # publishing is the git path's; not under test here
    agent = Agent(name="cloud-agent", project_id=str(project.id))
    await agent.save()
    return agent


async def _published(self, actor, force=False):
    return False


async def test_a_gcp_vm_deploy_whose_answer_the_load_balancer_drops_ends_on_the_hubs_push(agent, hub, monkeypatch):
    planned = hub.deployment(f"agent-{agent.id}", "production")
    subject = str(agent.typeid)
    ended: list[ActivityProgressSpec] = []
    done = asyncio.Event()

    def hear(root, transition) -> None:
        if root.is_terminal:
            ended.append(root.spec())
            done.set()

    # The machine step's first look at the placement's row once the hub's answer is gone: after it, that step
    # waits for the row to be written again.
    looked = asyncio.Event()
    read = Deployment.get_by_id

    async def get_by_id(eid):
        row = await read(eid)
        if hub.dropped.is_set() and eid == planned["id"]:
            looked.set()
        return row

    monkeypatch.setattr(Deployment, "get_by_id", staticmethod(get_by_id))
    stop = monitor.subscribe(hear)
    try:
        # The signed-in request, as the action reads it first; what it calls sees none, as in every deploy test.
        request = itertools.chain([SimpleNamespace(someone_typeid=OWNER)], itertools.repeat(None))
        with patch("flow_sdk.request_context.methods.get_current_request_info", side_effect=request):
            answer = await agent.deploy_action(AgentDeployRequest(provider="gcp_vm", environment="production"))

        assert answer.data == {
            "agent_id": agent.id,
            "activity": {"path": DEPLOY_ACTIVITY, "subject_entity": subject},
            "deployment_id": planned["id"],
        }

        await looked.wait()
        assert hub.sent == [{"environment": "production", "provider": "gcp_vm"}]
        waiting = monitor.get(DEPLOY_ACTIVITY, subject_entity=subject)
        assert (waiting.state, [(c.name, c.state) for c in waiting.children][-1]) == (
            ActivityState.RUNNING,
            ("machine", ActivityState.RUNNING),
        ), "a dropped answer is not a failure"

        # The hub's push of the placement with its machine: the bridge mirrors it into the row, which announces it.
        await hub_ws_bridge._handle_deployment_op(
            "update",
            planned["id"],
            {
                **planned,
                "updated_date": "2099-01-01T00:00:01Z",
                "origin": {"kind": "gcp_vm", "provider": "gcp_vm", "external_id": "compute_node-box"},
                "status": {"provider_state": "running"},
            },
        )
        await done.wait()
    finally:
        stop()

    final = ended[-1]
    assert [(c.name, c.state) for c in final.children][-1] == ("machine", ActivityState.COMPLETED)
    assert final.state == ActivityState.COMPLETED
    mirrored = await read(planned["id"])
    assert mirrored.origin.external_id == "compute_node-box" and mirrored.status.provider_state == "running"
