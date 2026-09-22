"""The voice matrix, pure pytest: phone (Twilio → SIP) × browser (mic + speakers) × sound file — one
body for all three, each over its driver's own ``Double`` (``data_driver/<voice_*>/tests/matrix.py``).

What a cell proves, identically on every voice channel — which is the claim that they are ONE kind
of channel to the system:

1. the call lands as one conversation on channel ``voice``, owned by the agent whose source it is,
   and inside that agent's stream inbox scope;
2. every sentence is a message — the caller's attributed to the caller, the voice's to the agent —
   stored the same way on every channel (``content.message.chat`` carrying ``ingest.message.voice``);
3. what the caller asked reached the agent as an ordinary turn in THAT conversation's session, and the
   agent's answer is what the voice said back;
4. while it happens the caller's words are announced live (``voice.call.partial``) on a live line.

Providers are data here, never branches: what differs per channel the ``Double`` says.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_calls import CALL_ENDED, answer_call, call_started
from flow_sdk.builtin.agent_serve import TurnEngine
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.stream_inbox.agent_scope import resolve_agent_stream_inbox_scope

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

VOICE_CHANNELS = ("voice_phone", "voice_browser", "voice_file")
UTTERANCE = "What is on my plate today?"


def double_for(provider: str, tmp_path):
    cls = load_module(SHIPPED_ROOT / provider / "tests", "matrix").Double
    return cls(utterance=UTTERANCE, folder=str(tmp_path / "clips")) if provider == "voice_file" else cls(utterance=UTTERANCE)


class Asked:
    """What the stubbed agent was asked: each turn's body, and the session it ran in."""

    def __init__(self):
        self.bodies: list[str] = []
        self.sessions: list[str] = []


def stub_the_turn(monkeypatch, nonce: str) -> Asked:
    """The agent is a stub answering with the nonce."""
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult  # noqa: PLC0415

    asked = Asked()

    class _Process:
        id = "p-voice"
        typeid = "agentic_process-p-voice"

        def __init__(self):
            self.context_data: dict = {}

        async def send_turn(self, body):
            asked.bodies.append(body)
            return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)

        async def save(self):
            pass

    process = _Process()

    async def process_for(self, session, *_a, **_k):
        asked.sessions.append(session)
        return process

    async def capture(_ap):
        return f"You have two meetings {nonce}."

    monkeypatch.setattr(TurnEngine, "process_for", process_for)
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", capture)
    return asked


async def make_agent_source(provider: str, double, monkeypatch):
    agent = Agent(name=f"voice {provider} {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
    await agent.save()
    monkeypatch.setattr(DataDriver.loaded(provider), "credentials_for", double.credentials)
    source = make_data_source(
        provider, name=f"voice {provider} {uuid.uuid4().hex[:6]}", config=dict(double.config), owner=agent.typeid,
        status=SourceStatus.ACTIVE.value, inbound_allowed_senders=[double.sender], **dict(double.fields),
    )
    await source.save()
    return agent, source


class Partials(list):
    """Every ``voice.call.partial`` announced while subscribed."""

    def __init__(self):
        super().__init__()
        from flow_sdk.tags import on_tag  # noqa: PLC0415

        async def _seen(event):
            self.append(dict(event.data or {}))

        self.unsubscribe = on_tag("voice.call.partial", _seen)


@pytest.mark.parametrize("provider", VOICE_CHANNELS)
async def test_a_call_on_any_voice_channel_is_one_conversation_the_agent_answers(provider, monkeypatch, tmp_path):
    nonce = uuid.uuid4().hex[:8]
    asked = stub_the_turn(monkeypatch, nonce)
    partials = Partials()
    async with double_for(provider, tmp_path) as double:
        agent, source = await make_agent_source(provider, double, monkeypatch)
        try:
            driver = DataDriver.loaded(provider)
            call = await double.ring(driver, source)
            assert call.caller == double.sender

            engine = TurnEngine(agent, await agent.local_deployment())
            conversation_id = await answer_call(engine, source, call)
            assert conversation_id, "the call was placed in no conversation"

            # 1. one conversation, on channel voice, the agent's — and in its stream inbox
            conversation = await Conversation.get_one({"id": conversation_id})
            assert str(conversation.owner) == str(agent.typeid)
            assert source.channel == "voice"
            scope = await resolve_agent_stream_inbox_scope(agent.id)
            assert conversation_id in set(map(str, scope.conversation_ids))

            # 2. every sentence a message, attributed, stored the same way on every channel
            answer = f"You have two meetings {nonce}."
            # On a live line the caller speaks over the greeting, which lands when it finishes speaking.
            expected = [call_started(call), UTTERANCE, *(["Hello, how can I help?"] if double.greets else []), answer, CALL_ENDED]
            messages = sorted(await FlowMessage.get_all({"conversation_id": conversation_id}), key=lambda m: str(m.sent_at))
            texts = [m.text for m in messages]
            assert texts == expected, texts
            heard = next(m for m in messages if m.text == UTTERANCE)
            assert heard.origin is not None and heard.origin.kind == "voice"
            assert heard.sender.kind == "external" and heard.sender.address == double.sender, heard.sender
            ours = next(m for m in messages if m.text == answer)
            assert ours.sender.kind == "agent" and ours.sender.id == str(agent.id), ours.sender
            rows = await SourceItem.get_all({"data_source_id": str(source.id)})
            assert {r.kind for r in rows} == {"content.message.chat"}
            assert {type(r.data).spec_kind for r in rows if r.data is not None} == {"ingest.message.voice"}

            # 3. the caller's request reached the agent, in that conversation's session
            assert len(asked.bodies) == 1 and UTTERANCE in asked.bodies[0], asked.bodies
            assert asked.sessions == [f"conversation-{conversation_id}"], asked.sessions
            if double.greets:
                assert double.fake.answers == [answer], "the voice was not handed the agent's answer"
                assert not double.fake.asked_to_speak_early, "the answer was pushed over a response still being spoken"

            # 4. live: the caller's words were announced as they came (a recorded clip has no partials)
            if double.greets:
                assert [p["text"] for p in partials if p.get("conversation_id") == conversation_id][-1] == UTTERANCE
            if double.keeps_audio:
                clips = [a for r in rows for a in getattr(r.data, "attachments", ())]
                assert len(clips) == 2 and all(c.data.path for c in clips), clips
        finally:
            partials.unsubscribe()
            await source.delete()
            await agent.delete()


@pytest.mark.parametrize("provider", ("voice_phone", "voice_browser"))
async def test_a_caller_the_line_does_not_admit_is_refused_before_anything_is_said(provider, monkeypatch, tmp_path):
    asked = stub_the_turn(monkeypatch, "x")
    async with double_for(provider, tmp_path) as double:
        agent, source = await make_agent_source(provider, double, monkeypatch)
        try:
            source.inbound_allowed_senders = ["+10000000000"]
            call = await double.ring(DataDriver.loaded(provider), source)
            if DataDriver.loaded(provider).cls.open_inbound:
                pytest.skip("an open line admits whoever is at it")
            engine = TurnEngine(agent, await agent.local_deployment())
            assert await answer_call(engine, source, call) is None
            assert "reject" in double.fake.verbs() and "sideband" not in double.fake.verbs()
            assert asked.bodies == []
            assert await SourceItem.get_all({"data_source_id": str(source.id)}) == []
        finally:
            await source.delete()
            await agent.delete()
