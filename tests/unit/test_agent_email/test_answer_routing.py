"""A caller routes a channel message; the gates still decide whether it is answered.

``answer(engine, m, session=..., process=...)`` is the seam a custom loop uses to choose which
session (one process per session on the engine's placement) or which live process answers a
message — ``docs/snippets/agent-deployment.md`` §6. The routing is the caller's; refusing a
sender, the loop guard and the ack are not.
"""

from types import SimpleNamespace

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.blocks.delivery import Delivered
from flow_sdk.builtin.agent_serve import TurnEngine, answer, turn_body
from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval

SOURCE = SimpleNamespace(id="ds-1", channel="whatsapp", provider="whatsapp")


class _Worker:
    def __init__(self, name: str) -> None:
        self.typeid = f"agentic_process-{name}"
        self.context_data: dict = {}
        self.prompts: list[str] = []

    async def send_turn(self, body: str) -> PromptResult:
        self.prompts.append(body)
        return PromptResult.satisfied("The turn was accepted.")

    async def save(self) -> None:
        pass

    def fetch_worker_status(self):
        """How the worker ended — the engine reads it the way AgenticProcess.run does. This one idles."""
        from flow_sdk.transcript_analyzer.worker_status import WorkerStatus  # noqa: PLC0415

        return WorkerStatus.IDLE


class _Message:
    def __init__(self, body: str = "my invoice is wrong", sender: str = "972500000000"):
        self.data_source_id, self.external_id = "ds-1", f"<{body}>"
        self.author_external_id, self.author_display, self.body = sender, "Dana", body
        self.replies: list[str] = []
        self.acks = 0

    async def _source(self):
        return SOURCE

    async def reply_spec(self, *, body, files=()):
        return body

    async def reply(self, spec):
        self.replies.append(spec)

    async def ack(self):
        self.acks += 1

    async def react_seen(self):
        return None  # a channel without reactions

    async def react_received(self):
        return None


async def _async(value):
    return value


@pytest.fixture
def engine(monkeypatch):
    engine = TurnEngine(SimpleNamespace(name="billing", id="1"), None)
    engine.sessions = {}

    async def process_for(session, **_):
        return engine.sessions.setdefault(session, _Worker(session))

    monkeypatch.setattr(agent_serve, "is_own_outgoing", lambda *_: False)
    monkeypatch.setattr(agent_serve, "admits", lambda _s, author: author != "stranger")
    monkeypatch.setattr(agent_serve, "conversation_of", lambda *_: _async("conv-1"))
    monkeypatch.setattr(engine, "process_for", process_for)
    monkeypatch.setattr(
        "flow_sdk.app.actions.execute_prompt._capture_assistant_reply", lambda ap: _async(f"re: {ap.prompts[-1]}")
    )
    return engine


async def test_a_session_routes_the_turn_and_is_found_again(engine):
    first, second = _Message("invoice one"), _Message("invoice two")

    assert await answer(engine, first, session="customer/972500000000") is True
    assert await answer(engine, second, session="customer/972500000000") is True

    assert list(engine.sessions) == ["customer/972500000000"], "the caller's session, not the conversation"
    assert engine.sessions["customer/972500000000"].prompts == ["invoice one", "invoice two"]
    assert first.replies == ["re: invoice one"] and second.replies == ["re: invoice two"]


async def test_without_a_session_the_message_answers_in_its_conversation(engine):
    await answer(engine, _Message())
    assert list(engine.sessions) == ["conversation-conv-1"]


async def test_a_process_the_caller_holds_takes_the_turn(engine):
    desk = _Worker("vip-desk")
    m = _Message("urgent")

    assert await answer(engine, m, process=desk) is True
    assert desk.prompts == ["urgent"] and engine.sessions == {}
    assert m.replies == ["re: urgent"]


async def test_routing_does_not_open_the_gate_and_a_gated_message_is_acked(engine):
    m = _Message(sender="stranger")

    assert await answer(engine, m, session="customer/stranger") is False
    assert engine.sessions == {} and m.replies == []
    assert m.acks == 1, "settled, so a per-message loop is not handed it again"


async def test_only_the_last_message_of_the_turn_is_the_reply(engine, monkeypatch):
    """The text a turn writes on the way (progress lines) never reaches the sender: the reply is its final message."""
    from flow_sdk.transcript_analyzer.entries import AssistantMessageEntry, UserMessageEntry

    base = {"session_id": "s1", "timestamp": "2026-09-06T00:00:00Z", "worker": "claude"}
    entries = [
        UserMessageEntry(id="u1", text="my invoice is wrong", **base),
        AssistantMessageEntry(id="a1", text="I am checking the invoice", **base),
        AssistantMessageEntry(id="a2", text="We received your message.", **base),
    ]
    monkeypatch.setattr(agent_serve, "transcript_entries", lambda _ap: entries)
    m = _Message()

    assert await answer(engine, m, session="customer/972500000000") is True
    assert m.replies == ["We received your message."]


def _channel_message(provider: str = "telegram", **fields) -> Delivered:
    """A message as the deployment loop hands it out: a stored SourceItem from *provider*."""
    item = SourceItemSpec(
        data_source_id="ds-1",
        provider=provider,
        kind="message",
        external_id="m-1",
        body="Hello, whats our status",
        **fields,
    )
    return Delivered(item, position=None, row=None, source_id="ds-1")


@pytest.mark.parametrize("provider", ["telegram", "slack", "whatsapp", "gmail", "http_chat"])
async def test_agent_prompt_names_the_channel_the_message_came_from(provider: str):
    assert provider in turn_body(_channel_message(provider))


async def test_agent_prompt_has_sender_and_conversation_context():
    message = _channel_message(author_display="Ishay Sela", author_external_id="tg-42")

    agent_prompt = turn_body(message, conversation_id="conv-1")

    assert "Ishay Sela" in agent_prompt and "tg-42" in agent_prompt
    assert "conv-1" in agent_prompt
    assert "forwarded to the user automatically" in agent_prompt
