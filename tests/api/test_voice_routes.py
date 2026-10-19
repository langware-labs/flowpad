"""The voice routes over HTTP, in-process: the webhook a carrier and OpenAI post to, and the route a
browser or a sound file starts a call through. Each call is answered by the agent that owns the
line — its turn stubbed — and read back as the conversation it left.

* ``POST /api/v1/data_source/webhook/voice_phone`` — a carrier's form gets TwiML bridging the call
  to OpenAI's SIP connector; an unsigned OpenAI event is refused; a signed one rings the agent.
* ``POST /api/v1/data_source/<id>/call`` — a browser's offer is answered with OpenAI's SDP; a clip
  handed in as bytes is answered with a spoken clip.
"""
from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin import agent_calls
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.testing import make_data_source
from tests.unit.test_voice_channel_matrix import UTTERANCE, stub_the_turn

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

WEBHOOK = "/api/v1/data_source/webhook/voice_phone"


def _double(provider: str, tmp_path):
    cls = load_module(SHIPPED_ROOT / provider / "tests", "matrix").Double
    return cls(utterance=UTTERANCE, folder=str(tmp_path / "clips")) if provider == "voice_file" else cls(utterance=UTTERANCE)


async def _line(provider: str, double, monkeypatch) -> tuple[Agent, DataSource]:
    for leftover in await DataSource.get_all({"provider": provider}):
        await leftover.delete()
    agent = Agent(name=f"voice route {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
    await agent.save()
    monkeypatch.setattr(DataDriver.loaded(provider), "credentials_for", double.credentials)
    source = make_data_source(provider, name=f"voice route {uuid.uuid4().hex[:6]}", config=dict(double.config),
                              owner=agent.typeid, status=SourceStatus.ACTIVE.value, allowed_senders=[double.sender])
    await source.save()
    return agent, source


async def _answered(call_id: str) -> str:
    """Wait for the call's own task — the answer runs in the background, as a live call does."""
    entry = agent_calls._CALLS.get(call_id)  # noqa: SLF001 — the test holds the call to its end
    if entry and entry.get("task") is not None:
        return await entry["task"] or ""
    return ""


def _data(response) -> dict:
    body = response.json()
    assert response.status_code == 200 and body.get("status") == "SUCCESS", response.text[:600]
    return body["data"]


async def test_a_carrier_asking_about_a_call_is_told_to_bridge_it_to_the_voice(bootstrapped_client, monkeypatch, tmp_path):
    async with _double("voice_phone", tmp_path) as double:
        agent, source = await _line("voice_phone", double, monkeypatch)
        try:
            form = {"CallSid": "CA123", "From": "+972501234567", "To": double.config["number"], "Direction": "inbound"}
            response = await bootstrapped_client.post(WEBHOOK, data=form)
            assert response.status_code == 200 and response.headers["content-type"].startswith("application/xml")
            assert "<Sip>sip:proj_matrix@sip.api.openai.com;transport=tls?X-Flow-Number=%2B14155550100</Sip>" in response.text, response.text
        finally:
            await source.delete()
            await agent.delete()


async def test_an_unsigned_call_event_is_refused(bootstrapped_client, monkeypatch, tmp_path):
    async with _double("voice_phone", tmp_path) as double:
        agent, source = await _line("voice_phone", double, monkeypatch)
        try:
            delivery = double.rings_back("rtc_forged")
            response = await bootstrapped_client.post(WEBHOOK, content=delivery["body"], headers={"Content-Type": "application/json",
                                                      "webhook-signature": "v1,forged", "webhook-id": "x", "webhook-timestamp": "1"})
            assert response.status_code == 401
            assert "accept" not in double.fake.verbs()
        finally:
            await source.delete()
            await agent.delete()


async def test_a_signed_call_rings_the_agent_and_is_answered(bootstrapped_client, monkeypatch, tmp_path):
    asked = stub_the_turn(monkeypatch, "phone")
    async with _double("voice_phone", tmp_path) as double:
        agent, source = await _line("voice_phone", double, monkeypatch)
        try:
            placed = _data(await bootstrapped_client.post(f"/api/v1/data_source/{source.id}/call", json={"offer": double.offer()}))
            assert placed["call_sid"] and double.dials, placed
            delivery = double.rings_back("rtc_route")
            rung = _data(await bootstrapped_client.post(WEBHOOK, content=delivery["body"],
                                                        headers={"Content-Type": "application/json", **delivery["headers"]}))
            assert rung["rung"] == ["rtc_route"], rung
            conversation = await _answered("rtc_route")
            texts = [m.text for m in await FlowMessage.get_all({"conversation_id": conversation})]
            assert UTTERANCE in texts and "You have two meetings phone." in texts, texts
            # The dial's purpose rode to the voice: a placed call opens with why it calls.
            (session,) = double.fake.accepted
            assert "Confirm tomorrow's delivery window." in session["instructions"], session["instructions"]
            assert len(asked.bodies) == 1 and UTTERANCE in asked.bodies[0]
        finally:
            await source.delete()
            await agent.delete()


async def test_a_browser_offer_is_answered_and_the_call_lands_in_the_conversation(bootstrapped_client, monkeypatch, tmp_path):
    stub_the_turn(monkeypatch, "browser")
    async with _double("voice_browser", tmp_path) as double:
        agent, source = await _line("voice_browser", double, monkeypatch)
        try:
            answer = _data(await bootstrapped_client.post(f"/api/v1/data_source/{source.id}/call", json={"offer": double.offer()}))
            assert answer["sdp"].startswith("v=0") and answer["call_id"].startswith("rtc_"), answer
            conversation = await _answered(answer["call_id"])
            texts = [m.text for m in await FlowMessage.get_all({"conversation_id": conversation})]
            assert UTTERANCE in texts and "You have two meetings browser." in texts, texts
        finally:
            await source.delete()
            await agent.delete()


async def test_a_clip_handed_in_is_answered_with_a_spoken_clip(bootstrapped_client, monkeypatch, tmp_path):
    stub_the_turn(monkeypatch, "clip")
    async with _double("voice_file", tmp_path) as double:
        agent, source = await _line("voice_file", double, monkeypatch)
        try:
            started = _data(await bootstrapped_client.post(f"/api/v1/data_source/{source.id}/call", json={"offer": double.offer()}))
            conversation = await _answered(started["call_id"])
            texts = [m.text for m in await FlowMessage.get_all({"conversation_id": conversation})]
            assert UTTERANCE in texts and "You have two meetings clip." in texts, texts
            replies = list((Path(double.config["folder"]) / "out").glob("*-reply.mp3"))
            assert len(replies) == 1 and replies[0].read_bytes() == b"ID3You have two meetings clip.", replies
        finally:
            await source.delete()
            await agent.delete()


async def test_a_call_route_on_a_source_that_takes_no_calls_says_so(bootstrapped_client):
    source = make_data_source("rss", config={"feed_url": "https://example.invalid/feed"})
    await source.save()
    try:
        response = await bootstrapped_client.post(f"/api/v1/data_source/{source.id}/call", json={"offer": {}})
        assert response.json()["status"] != "SUCCESS" and "takes no calls" in response.text
    finally:
        await source.delete()


def test_the_matrix_clip_is_bytes_a_clip_is_made_of():
    wav = base64.b64decode(load_module(SHIPPED_ROOT / "voice_file" / "tests", "matrix").Double().offer()["audio_b64"])
    assert wav[:4] == b"RIFF"


async def test_hanging_up_from_the_browser_ends_the_call_here(bootstrapped_client, monkeypatch, tmp_path):
    """The side that holds the call ends it: the provider is told to hang up."""
    from flow_sdk.builtin.agent_calls import _CALLS  # noqa: PLC0415

    class _Session:
        hung = False

        async def hangup(self):
            _Session.hung = True

    _CALLS["rtc_hang"] = {"source_id": "src-1", "caller": "ada", "session": _Session()}
    try:
        wrong = _data(await bootstrapped_client.post("/api/v1/data_source/src-2/call/rtc_hang/hangup", json={}))
        assert wrong["hung_up"] is False and not _Session.hung
        right = _data(await bootstrapped_client.post("/api/v1/data_source/src-1/call/rtc_hang/hangup", json={}))
        assert right["hung_up"] is True and _Session.hung
    finally:
        _CALLS.pop("rtc_hang", None)
