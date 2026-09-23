"""A deployment's timeline — over the real app, its chat channel, a mock worker.

A message on the deployment's ``chat`` channel is answered by its loop (:func:`serve`, a task here in
place of its process); ``GET /deployment/<id>/timeline`` then reads what happened from the rows, newest
first, each event naming its process. The loop says the timeline moved with ``deployment.timeline``
tags, and its reply's copy is announced when it lands — in its own process relayed to the app
(``POST /api/v1/tags/relay``), which takes only the tags it forwards to clients anyway.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import serve, stop_serving
from flow_sdk.builtin.service_endpoint import ServiceEndpoint
from flow_sdk.tags.bus import event_bus
from tests.utils.mock_worker import MockDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


@pytest.fixture
def timeline_tags():
    """Every ``deployment.timeline`` tag emitted on this process's bus, as ``(deployment_id, kind)``."""
    seen: list[tuple[str, str]] = []

    async def on(event):
        seen.append((event.data.get("deployment_id"), event.data.get("kind")))

    unsubscribe = event_bus.on("deployment.timeline", on)
    yield seen
    unsubscribe()


@pytest.fixture
async def deployed(worker, user):
    agent = Agent(name=f"timeline-agent-{time.monotonic_ns()}", worker_type="claude", system_prompt="Answer briefly.")
    await agent.save()
    deployment = await agent.run_locally()
    chat = await ServiceEndpoint.find_existing(str(deployment.typeid), "chat")
    loop = asyncio.create_task(serve(agent, deployment, poll_every=0.05))
    yield agent, deployment, chat
    await stop_serving(loop)
    await agent.delete()


async def _chat(client, chat, text: str) -> dict:
    resp = await client.post(
        f"/api/v1/graph/service_endpoint/{chat.id}/service/v1/chat/completions",
        json={"model": "agent", "messages": [{"role": "user", "content": text}]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _timeline(client, deployment, **params) -> dict:
    resp = await client.get(f"/api/v1/graph/deployment/{deployment.id}/timeline", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


async def test_a_message_answered_on_the_deployment_is_its_timeline(deployed, bootstrapped_client, timeline_tags):
    _agent, deployment, chat = deployed
    await _chat(bootstrapped_client, chat, "hello there")

    page = await _timeline(bootstrapped_client, deployment)
    kinds = [e["kind"] for e in page["events"]]
    assert kinds == ["reply_sent", "turn_started", "message_in"], kinds
    reply, started, message = page["events"]
    assert message["text"] == "hello there" and reply["text"].startswith("Mock reply")
    assert message["channel"] == "http_chat" and message["data_source_id"] == chat.backend.data_source_id
    assert {e["process_id"] for e in page["events"]} == {started["process_id"]} != {""}, "one process answered it"
    assert message["conversation_id"] and page["before"] is None

    kinds_announced = [kind for dep, kind in timeline_tags if dep == str(deployment.id)]
    assert kinds_announced == ["message_in", "turn_started"], "each fact said as it happened"


async def test_the_reply_is_announced_when_it_lands_on_the_channel(deployed, bootstrapped_client):
    """The loop places channel items silently — but its own reply's copy is announced, the moment the
    reply's row exists, so a watcher reading the timeline then sees it."""
    _agent, _deployment, chat = deployed
    landed = asyncio.Event()

    async def on(event):
        if event.data.get("source_id") == chat.backend.data_source_id:
            landed.set()

    unsubscribe = event_bus.on("stream_inbox.*.message.projected", on)
    try:
        await _chat(bootstrapped_client, chat, "hello there")
        await landed.wait()  # the copy is placed on the loop's next pass; the file's timeout bounds it
    finally:
        unsubscribe()


async def test_the_timeline_pages_back(deployed, bootstrapped_client):
    _agent, deployment, chat = deployed
    await _chat(bootstrapped_client, chat, "first")
    await _chat(bootstrapped_client, chat, "second")

    newest = await _timeline(bootstrapped_client, deployment, limit=3)
    assert [e["kind"] for e in newest["events"]] == ["reply_sent", "turn_started", "message_in"]
    assert newest["events"][2]["text"] == "second" and newest["before"]
    older = await _timeline(bootstrapped_client, deployment, limit=3, before=newest["before"])
    assert [e["text"] for e in older["events"] if e["kind"] == "message_in"] == ["first"]


async def test_a_relayed_tag_is_emitted_on_the_apps_bus(bootstrapped_client, timeline_tags):
    envelope = {"tag": "deployment.timeline", "target": "deployment:d-1", "data": {"deployment_id": "d-1", "kind": "reply_sent"}}
    resp = await bootstrapped_client.post("/api/v1/tags/relay", json=envelope)
    assert resp.status_code == 200, resp.text
    await asyncio.sleep(0)  # the bus dispatches on the loop
    assert ("d-1", "reply_sent") in timeline_tags


async def test_the_relay_takes_only_what_the_app_forwards(bootstrapped_client):
    resp = await bootstrapped_client.post("/api/v1/tags/relay", json={"tag": "entity.deleted", "target": "x:1", "data": {}})
    assert resp.status_code == 400


def test_everything_relayed_reaches_the_apps_clients():
    """A relayed tag is re-emitted on the app's bus only to be forwarded to its clients."""
    from flow_sdk.tags.grammar import tag_matches
    from flow_sdk.tags.relay import RELAYED_TAG_PATTERNS
    from flow_sdk.tags.ws_forward import FORWARDED_TAG_PATTERNS

    for pattern in RELAYED_TAG_PATTERNS:
        example = pattern.replace("*", "x")
        assert any(tag_matches(f, example) for f in FORWARDED_TAG_PATTERNS), pattern


async def test_each_conversation_is_one_thread_with_its_own_events(deployed, bootstrapped_client):
    _agent, deployment, chat = deployed
    await _chat(bootstrapped_client, chat, "first question")
    await _chat(bootstrapped_client, chat, "second question")

    resp = await bootstrapped_client.get(f"/api/v1/graph/deployment/{deployment.id}/threads")
    assert resp.status_code == 200, resp.text
    threads = resp.json()["data"]["threads"]
    assert len(threads) == 2, "two chats, two threads"
    assert all(t["status"] == "idle" and t["messages"] == 2 and t["turns"] == 1 for t in threads), threads
    assert [t["last_text"].startswith("Mock reply") for t in threads] == [True, True]
    assert all(t["channel"] == "http_chat" and t["process_id"] for t in threads)

    # The thread's id is the Conversation row's (the chat's own `conversation_id` is its channel thread key).
    one = next(t["conversation_id"] for t in threads if t["title"].startswith("first question"))
    page = await _timeline(bootstrapped_client, deployment, conversation=one)
    assert {e["conversation_id"] for e in page["events"]} == {one}, "only that thread's events"
    assert [e["kind"] for e in page["events"]] == ["reply_sent", "turn_started", "message_in"]
    assert page["events"][-1]["text"] == "first question"
