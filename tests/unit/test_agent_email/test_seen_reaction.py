"""While the agent works on a channel message, the person sees it has been seen; once the answer is out, it is gone.

``answer_one`` asks the message to show it is seen (``react_seen``) before the turn runs, and takes ours back
(``unreact_seen``) after the reply — only when a reaction was put: a channel without reactions shows nothing.
Which emoji, and whether the channel reacts at all, is the message's and its driver's (test_message_files_and_reactions).
"""

from types import SimpleNamespace

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent_serve import TurnEngine, answer_one

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval

SOURCE = SimpleNamespace(id="ds-1", channel="telegram", provider="telegram")


class _Driver:
    pass


class _Message:
    """A channel message that records, in order, what Flowpad does to it. ``seen`` is what its channel shows."""

    def __init__(self, seen: "str | None", body: str = "Hello, whats our status"):
        self.data_source_id, self.external_id = "ds-1", "<m-1>"
        self.author_external_id, self.author_display, self.body = "tg-42", "Dana", body
        self.seen = seen
        self.calls: list = []

    async def react_seen(self):
        self.calls.append("react_seen")
        return self.seen

    async def unreact_seen(self):
        self.calls.append("unreact_seen")

    async def reply_spec(self, *, body, files=()):
        return body

    async def reply(self, spec):
        self.calls.append(("reply", spec))

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


async def test_the_message_shows_seen_while_the_agent_answers_it(engine):
    message = _Message(seen="👀")

    assert await answer_one(engine, message, source=SOURCE) is True

    assert message.calls == ["react_seen", ("reply", "re: Hello, whats our status"), "unreact_seen"]


async def test_a_channel_without_reactions_is_answered_without_taking_any_back(engine):
    message = _Message(seen=None)

    assert await answer_one(engine, message, source=SOURCE) is True

    assert message.calls == ["react_seen", ("reply", "re: Hello, whats our status")]
