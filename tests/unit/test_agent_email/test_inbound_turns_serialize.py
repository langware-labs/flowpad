"""Messages that land together on an agent's channel are answered one turn at a time.

Found by sending five WhatsApp messages in a burst: the first became a turn, three were refused with
"another prompt turn is already in flight" and never answered, and the two turns that overlapped each
captured the LATEST reply and sent it twice. Every message is now its own turn, in arrival order.
"""
import asyncio
from types import SimpleNamespace

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent_serve import TurnEngine, answer
from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


class _Worker:
    """A headless process: refuses a prompt while one is in flight; a turn's reply echoes its prompt."""

    typeid = "agentic_process-w1"

    def __init__(self) -> None:
        self.in_flight = False
        self.last = ""
        self.context_data: dict = {}

    async def send_turn(self, body: str) -> PromptResult:
        if self.in_flight:
            return PromptResult.not_yet("another prompt turn is already in flight for this process", ran=False)
        self.in_flight, self.last = True, body
        return PromptResult.satisfied("The turn was accepted.")

    async def finish(self) -> str:
        await asyncio.sleep(0.05)  # the turn runs long enough for the next message to arrive
        self.in_flight = False
        return f"reply to {self.last}"

    async def save(self) -> None:
        pass


class _Message:
    """A delivered channel message: its reply goes back on the channel it came from."""

    def __init__(self, n: int, sent: list):
        self.data_source_id, self.external_id = "ds-1", f"<m{n}>"
        self.author_external_id, self.author_display, self.body = "972500000000", "Dana", f"burst {n}"
        self._sent = sent

    async def reply_spec(self, *, body):
        return body

    async def reply(self, spec):
        self._sent.append(f"{spec} (quoting {self.body})")


async def test_messages_arriving_together_each_get_their_own_turn(monkeypatch):
    worker, sent = _Worker(), []
    source = SimpleNamespace(id="ds-1", channel="whatsapp", provider="waha")
    engine = TurnEngine(SimpleNamespace(name="a", id="1"), None)

    monkeypatch.setattr(agent_serve, "is_own_outgoing", lambda *_: False)
    monkeypatch.setattr(agent_serve, "admits", lambda *_: True)
    monkeypatch.setattr(agent_serve, "conversation_of", lambda *_: _async("conv-1"))
    monkeypatch.setattr(engine, "process_for", lambda *_, **__: _async(worker))
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", lambda _ap: worker.finish())

    results = await asyncio.gather(*(answer(engine, _Message(n, sent), source=source) for n in range(1, 4)))

    assert results == [True, True, True]
    assert sent == [f"reply to burst {n} (quoting burst {n})" for n in range(1, 4)]


async def _async(value):
    return value
