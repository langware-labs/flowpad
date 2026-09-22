"""A deployed agent's ``chat`` endpoint, over the real app, with a scripted worker.

The endpoint is the agent's OpenAI face (``server/routes/agent_chat.py``): a turn
through the one turn engine (``builtin/agent_serve``), on the placement the endpoint
belongs to. These pin the surface a client relies on — a completion, a streamed
completion, a conversation that continues, a history — and that a conversation
belongs to its caller.
"""

from __future__ import annotations

import json
import time

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer, ensure_chat_endpoint
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.server.service_proxy import CALLER_HEADER, sign_caller
from tests.utils.mock_worker import MockDriver

pytestmark = pytest.mark.asyncio

GATE = "gate-secret-for-chat-tests"


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


@pytest.fixture
async def chat(worker, user):
    agent = Agent(name=f"chat-agent-{time.monotonic_ns()}", worker_type="claude", system_prompt="Answer briefly.")
    await agent.save()
    deployment = await agent.local_deployment()
    endpoint = await ensure_chat_endpoint(agent, deployment)
    yield endpoint
    await agent.delete()


def _url(endpoint, path: str) -> str:
    return f"/api/v1/graph/service_endpoint/{endpoint.id}/service/{path}"


def _ask(text: str, **extra) -> dict:
    return {"model": "agent", "messages": [{"role": "user", "content": text}], **extra}


async def test_concurrent_ensures_make_one_chat_endpoint(worker, user):
    """The supervisor and a box's expose-endpoints ensure it at the same moment on a deploy."""
    import asyncio

    agent = Agent(name=f"racing-agent-{time.monotonic_ns()}", worker_type="claude")
    await agent.save()
    try:
        placement = await agent.local_deployment()
        rows = await asyncio.gather(*(ensure_chat_endpoint(agent, placement) for _ in range(4)))
        assert len({r.id for r in rows}) == 1
        assert [e.name for e in await ServiceEndpoint.of_deployment(str(placement.typeid))].count("chat") == 1
    finally:
        await agent.delete()


async def test_every_agent_placement_has_one_chat_endpoint(chat, user):
    again = await ensure_chat_endpoint(await Agent.get_by_id(chat.backend.agent_id), await _placement(chat))
    assert again.id == chat.id, "idempotent"
    assert chat.name == "chat" and chat.protocol.spec_kind == "api.chat.openai"
    assert chat.backend.type == "agent"


async def _placement(endpoint):
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.fs_store.type_id import TypeId

    return await Deployment.get_by_typeid(TypeId(endpoint.parent_type_id))


async def test_a_completion_is_the_agents_turn(chat, bootstrapped_client, worker):
    resp = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("hello there"))

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"].startswith("Mock reply")
    assert worker.received_prompts == ["hello there"]
    assert resp.headers["x-flowpad-conversation"] == body["flowpad"]["conversation_id"]


async def test_a_conversation_continues_in_one_process(chat, bootstrapped_client, worker):
    first = (await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("one"))).json()
    conversation = first["flowpad"]["conversation_id"]
    await bootstrapped_client.post(
        _url(chat, "v1/chat/completions"), json=_ask("two", metadata={"conversation_id": conversation})
    )

    history = (await bootstrapped_client.get(_url(chat, f"v1/conversations/{conversation}"))).json()
    assert [m["role"] for m in history["messages"]] == ["user", "assistant", "user", "assistant"]
    assert [m["content"] for m in history["messages"] if m["role"] == "user"] == ["one", "two"]


async def test_a_streamed_completion_is_openai_chunks(chat, bootstrapped_client):
    resp = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("stream it", stream=True))

    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/event-stream")
    events = [line[len("data: ") :] for line in resp.text.splitlines() if line.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant"}
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert text.startswith("Mock reply")
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    assert {c["flowpad"]["conversation_id"] for c in chunks} == {resp.headers["x-flowpad-conversation"]}


async def test_the_model_list_is_this_agent(chat, bootstrapped_client):
    resp = await bootstrapped_client.get(_url(chat, "v1/models"))
    assert resp.json()["data"] == [{"id": f"agent-{chat.backend.agent_id}", "object": "model", "owned_by": "flowpad"}]


async def test_a_conversation_belongs_to_its_caller(chat, bootstrapped_client, monkeypatch):
    import flow_sdk.instance_settings.cookie_gate as gate

    monkeypatch.setattr(gate, "get_cookie_gate", lambda: GATE)
    dana = {CALLER_HEADER: sign_caller("user-dana", GATE, now=int(time.time()))}
    lee = {CALLER_HEADER: sign_caller("user-lee", GATE, now=int(time.time()))}
    forged = {CALLER_HEADER: sign_caller("user-dana", "not-the-gate", now=int(time.time()))}

    first = await bootstrapped_client.post(_url(chat, "v1/chat/completions"), json=_ask("mine"), headers=dana)
    conversation = first.json()["flowpad"]["conversation_id"]
    path = _url(chat, f"v1/conversations/{conversation}")

    assert len((await bootstrapped_client.get(path, headers=dana)).json()["messages"]) == 2
    assert (await bootstrapped_client.get(path, headers=lee)).json()["messages"] == [], "not lee's conversation"
    assert (await bootstrapped_client.get(path, headers=forged)).json()["messages"] == [], "a forged caller is nobody"


async def test_a_chat_endpoint_has_no_direct_address(chat, bootstrapped_client):
    resp = await bootstrapped_client.get(f"/api/v1/graph/service_endpoint/{chat.id}/direct-url")
    assert resp.status_code == 409


async def test_an_empty_turn_is_refused(chat, bootstrapped_client):
    resp = await bootstrapped_client.post(
        _url(chat, "v1/chat/completions"), json={"messages": [{"role": "assistant", "content": "hi"}]}
    )
    assert resp.status_code == 400


async def test_the_agent_server_gives_every_local_placement_its_chat(worker, user):
    agent = Agent(name=f"served-agent-{time.monotonic_ns()}", worker_type="claude")
    await agent.save()
    deployment = await agent.local_deployment()
    try:
        await AgentServer(serve_channels=False).reconcile()
        chat = await ServiceEndpoint.find_existing(str(deployment.typeid), "chat")
        assert chat is not None and chat.backend.agent_id == agent.id
    finally:
        await agent.delete()


async def test_a_box_reports_an_agent_placements_chat(chat, bootstrapped_client, tmp_path):
    """The hub names the agent's placement; the box answers with its chat — the project's web placement is untouched."""
    from flow_sdk.builtin.project import Project

    project = Project(name=f"agent-proj-{time.monotonic_ns()}", fs_storage_mount_path=str(tmp_path))
    await project.save()

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project.id}/expose-endpoints", json={"deployment_typeid": chat.parent_type_id}
    )

    assert resp.status_code == 200, resp.text
    assert [e["id"] for e in resp.json()["data"]["endpoints"]] == [chat.id]
