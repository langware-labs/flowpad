"""A caller routes a channel message; the gates still decide whether it is answered.

``answer(engine, m, session=..., process=...)`` is the seam a custom loop uses to choose which
session (one process per session on the engine's placement) or which live process answers a
message — ``docs/snippets/agent-deployment.md`` §6. The routing is the caller's; refusing a
sender, the loop guard and the ack are not.
"""
from types import SimpleNamespace

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent_serve import TurnEngine, answer
from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval

SOURCE = SimpleNamespace(id="ds-1", channel="whatsapp", provider="waha")


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

    async def reply_spec(self, *, body):
        return body

    async def reply(self, spec):
        self.replies.append(spec)

    async def ack(self):
        self.acks += 1


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
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", lambda ap: _async(f"re: {ap.prompts[-1]}"))
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
