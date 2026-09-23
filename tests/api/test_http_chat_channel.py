"""A deployment's ``chat`` endpoint is an HTTP message channel — over the real app, a mock worker.

``POST v1/chat/completions`` → the request is a message on the deployment's ``http_chat`` channel
(``server/routes/service_channel.py``) → the deployment's loop (:func:`serve`, run here as a task in
place of its process) answers it through the one turn engine → the reply the channel records is the
response. These pin what a client relies on: a completion, a conversation that continues in one
process, a conversation that is its caller's own, and a request nobody answers yet.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer, answered_sources, ensure_chat_channel, serve, stop_serving
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.server.service_proxy import CALLER_HEADER, sign_caller
from tests.utils.mock_worker import MockDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

GATE = "gate-secret-for-chat-tests"


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


@pytest.fixture
async def deployed(worker, user):
    """An agent launched here: a running local deployment and its chat channel — its loop a task."""
    agent = Agent(name=f"chat-agent-{time.monotonic_ns()}", worker_type="claude", system_prompt="Answer briefly.")
    await agent.save()
    deployment = await agent.run_locally()
    chat = await ServiceEndpoint.find_existing(str(deployment.typeid), "chat")
    loop = asyncio.create_task(serve(agent, deployment, poll_every=0.05))
    yield agent, deployment, chat
    await stop_serving(loop)  # between cycles, as the process's own SIGTERM does — never a bare cancel
    await agent.delete()


def _url(endpoint, path: str) -> str:
    return f"/api/v1/graph/service_endpoint/{endpoint.id}/service/{path}"


def _ask(text: str, **extra) -> dict:
    return {"model": "agent", "messages": [{"role": "user", "content": text}], **extra}


async def test_launching_here_makes_a_running_deployment_with_a_chat_channel(deployed):
    agent, deployment, chat = deployed
    assert deployment.serving and deployment.is_local
    assert chat.name == "chat" and chat.protocol.spec_kind == "api.chat.openai" and chat.backend.type == "channel"
    channel = await DataSource.get_by_id(chat.backend.data_source_id)
    assert str(channel.owner) == str(agent.typeid) and channel.answer_place == deployment.id
    assert [s.id for s in await answered_sources(agent, deployment)] == [channel.id], "the loop answers its chat"
    again = await ensure_chat_channel(agent, deployment)
    assert again.id == chat.id and again.backend.data_source_id == channel.id, "idempotent"


async def test_a_completion_is_the_agents_reply_on_the_channel(deployed, bootstrapped_client, worker):
    _agent, _deployment, chat = deployed
    resp = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("hello there"))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"].startswith("Mock reply")
    assert resp.headers["X-Flowpad-Conversation"] == body["flowpad"]["conversation_id"]
    assert worker.received_prompts == ["hello there"]
    rows = await SourceItem.get_all({"data_source_id": chat.backend.data_source_id})
    assert sorted(r.body.startswith("Mock reply") for r in rows) == [False, True], "the request and its reply, both on the channel"


async def test_a_conversation_continues_in_one_process(deployed, bootstrapped_client, worker):
    _agent, deployment, chat = deployed
    first = (await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("one"))).json()
    conversation = first["flowpad"]["conversation_id"]
    second = await bootstrapped_client.post(
        _url(chat, "v1/chat/completions"), json=_ask("two", metadata={"conversation_id": conversation})
    )
    assert second.status_code == 200 and second.json()["flowpad"]["conversation_id"] == conversation
    assert worker.received_prompts == ["one", "two"]
    assert len(await AgenticProcess.local_rows({"match": {"deployment_id": deployment.id}})) == 1


async def test_a_conversation_belongs_to_its_caller(deployed, bootstrapped_client, monkeypatch):
    import flow_sdk.instance_settings.cookie_gate as gate

    _agent, deployment, chat = deployed
    monkeypatch.setattr(gate, "get_cookie_gate", lambda: GATE)
    dana = {CALLER_HEADER: sign_caller("user-dana", GATE, now=int(time.time()))}
    lee = {CALLER_HEADER: sign_caller("user-lee", GATE, now=int(time.time()))}

    first = (await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("mine"), headers=dana)).json()
    same_id = {"conversation_id": first["flowpad"]["conversation_id"]}
    other = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("also mine?", metadata=same_id), headers=lee)

    assert other.status_code == 200
    assert len(await AgenticProcess.local_rows({"match": {"deployment_id": deployment.id}})) == 2, "lee is not in dana's session"


async def test_a_streamed_completion_and_the_history_read_from_the_channel(deployed, bootstrapped_client):
    """What the app's chat panel (``AgentChat``) speaks: SSE chunks, then the conversation so far."""
    import json

    _agent, _deployment, chat = deployed
    resp = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("stream it", stream=True))
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/event-stream")
    events = [line[len("data: "):] for line in resp.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert "".join(c["choices"][0]["delta"].get("content", "") for c in chunks).startswith("Mock reply")
    conversation = chunks[0]["flowpad"]["conversation_id"]

    history = (await bootstrapped_client.get(_url(chat, f"v1/conversations/{conversation}"))).json()
    assert [m["role"] for m in history["messages"]] == ["user", "assistant"]
    assert history["messages"][0]["content"] == "stream it"


async def test_the_model_list_names_the_endpoint(deployed, bootstrapped_client):
    _agent, _deployment, chat = deployed
    resp = await bootstrapped_client.get(_url(chat, "v1/models"))
    assert resp.status_code == 200 and resp.json()["data"][0]["id"] == f"endpoint-{chat.id}"


async def test_an_empty_message_is_refused(deployed, bootstrapped_client):
    _agent, _deployment, chat = deployed
    resp = await bootstrapped_client.post(
        _url(chat, "v1/chat/completions"), json={"model": "agent", "messages": [{"role": "user", "content": "  "}]}
    )
    assert resp.status_code == 400


async def test_a_chat_endpoint_has_no_direct_address(deployed, bootstrapped_client):
    _agent, _deployment, chat = deployed
    resp = await bootstrapped_client.get(f"/api/v1/graph/service_endpoint/{chat.id}/direct-url")
    assert resp.status_code == 409


async def test_with_no_loop_running_the_request_says_no_reply_yet(worker, user, bootstrapped_client, monkeypatch):
    """Nobody drains the channel: the caller hears so at the deadline; the message stays for the loop."""
    import flow_sdk.server.routes.service_channel as route

    monkeypatch.setattr(route, "REPLY_DEADLINE_SECONDS", 0.3)
    agent = Agent(name=f"idle-agent-{time.monotonic_ns()}", worker_type="claude")
    await agent.save()
    try:
        deployment = await agent.run_locally()
        chat = await ServiceEndpoint.find_existing(str(deployment.typeid), "chat")
        resp = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("anyone?"))
        assert resp.status_code == 504 and resp.json()["error"]["type"] == "no_reply_yet"
        (waiting,) = await SourceItem.get_all({"data_source_id": chat.backend.data_source_id})
        assert waiting.body == "anyone?"
    finally:
        await agent.delete()


async def test_the_supervisor_makes_the_chat_of_a_running_deployment(worker, user):
    """In the test tier the supervisor starts no process, but a running deployment still gets its chat."""
    agent = Agent(name=f"served-agent-{time.monotonic_ns()}", worker_type="claude")
    await agent.save()
    try:
        deployment = await agent.deploy("local")
        deployment.serving = True
        await deployment.save()
        await AgentServer(run_processes=False).reconcile()
        chat = await ServiceEndpoint.find_existing(str(deployment.typeid), "chat")
        assert chat is not None and chat.backend.type == "channel"
    finally:
        await agent.delete()


async def test_a_box_reports_an_agent_placements_chat(deployed, bootstrapped_client, tmp_path):
    """The hub names the agent's placement; the box answers with its chat — the project's web placement is untouched."""
    from flow_sdk.builtin.project import Project

    _agent, _deployment, chat = deployed
    project = Project(name=f"agent-proj-{time.monotonic_ns()}", fs_storage_mount_path=str(tmp_path))
    await project.save()

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": chat.parent_type_id}
    )

    assert resp.status_code == 200, resp.text
    assert [e["id"] for e in resp.json()["data"]["endpoints"]] == [chat.id]
