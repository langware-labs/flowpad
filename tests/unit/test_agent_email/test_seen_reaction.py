"""While the agent works on a channel message the person sees it was seen; once the answer is out, that it was received.

``answer_one`` asks the message to show it is seen (``react_seen``) before the turn runs, and received
(``react_received``) after the reply. Which emoji, and whether the channel reacts at all, is the message's and its
driver's (test_message_files_and_reactions): a channel without reactions shows nothing.
"""

from types import SimpleNamespace
from typing import NamedTuple

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent_serve import TurnEngine, answer_one

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval

SOURCE = SimpleNamespace(id="ds-1", channel="telegram", provider="telegram")


class _Driver:
    pass


class Call(NamedTuple):
    """One thing Flowpad did to the message, with what it said when it replied."""

    name: str
    text: str = ""


class _Message:
    """A channel message that records, in order, what Flowpad does to it."""

    def __init__(self, body: str = "Hello, whats our status"):
        self.data_source_id, self.external_id = "ds-1", "<m-1>"
        self.author_external_id, self.author_display, self.body = "tg-42", "Dana", body
        self.calls: list[Call] = []

    async def react_seen(self):
        self.calls.append(Call(name="react_seen"))
        return "👀"

    async def react_received(self):
        self.calls.append(Call(name="react_received"))
        return "👍"

    async def reply_spec(self, *, body, files=()):
        return body

    async def reply(self, spec):
        self.calls.append(Call(name="reply", text=spec))

    async def ack(self):
        pass


async def _async(value):
    return value


@pytest.fixture
def engine(monkeypatch):
    engine = TurnEngine(SimpleNamespace(name="qa-manager", id="1"), None)

    async def run(turn, process=None):
        return SimpleNamespace(ok=True, text=f"re: {turn.body}", detail="", timed_out=False)

    monkeypatch.setattr(engine, "run", run)
    monkeypatch.setattr(agent_serve, "is_own_outgoing", lambda *_: False)
    monkeypatch.setattr(agent_serve, "admits", lambda *_: True)
    monkeypatch.setattr(agent_serve, "conversation_of", lambda *_: _async("conv-1"))
    monkeypatch.setattr(agent_serve, "_driver_cls", lambda _source: _Driver)
    return engine


async def test_the_message_shows_seen_then_the_reply_then_received(engine):
    message = _Message()

    assert await answer_one(engine, message, source=SOURCE) is True

    assert message.calls == [
        Call(name="react_seen"),
        Call(name="reply", text="re: Hello, whats our status"),
        Call(name="react_received"),
    ]
