"""While the agent works on a channel message, the person sees 👀 on it; once the answer is out, it is gone.

``answer_one`` puts the reaction on before the turn runs and takes ours back after it — on a channel whose
driver reacts (``Reacting``). On any other channel the message is answered exactly as before.
"""

from types import SimpleNamespace

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent_serve import TurnEngine, answer_one

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval

SOURCE = SimpleNamespace(id="ds-1", channel="telegram", provider="telegram")


class _ReactingDriver:
    async def react(self, target, emoji: str) -> None: ...

    async def unreact(self, target, emoji: str = "") -> None: ...


class _PlainDriver:
    pass


class _Message:
    """A channel message that records, in order, what Flowpad does to it."""

    def __init__(self, body: str = "Hello, whats our status"):
        self.data_source_id, self.external_id = "ds-1", "<m-1>"
        self.author_external_id, self.author_display, self.body = "tg-42", "Dana", body
        self.calls: list[tuple[str, str]] = []

    async def react(self, emoji: str):
        self.calls.append(("react", emoji))

    async def unreact(self, emoji: str = ""):
        self.calls.append(("unreact", emoji))

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
    return engine


async def test_the_message_shows_eyes_while_the_agent_answers_it(engine, monkeypatch):
    monkeypatch.setattr(agent_serve, "_driver_cls", lambda _source: _ReactingDriver)
    message = _Message()

    assert await answer_one(engine, message, source=SOURCE) is True

    assert message.calls == [("react", "👀"), ("reply", "re: Hello, whats our status"), ("unreact", "")]


async def test_a_channel_without_reactions_is_answered_without_them(engine, monkeypatch):
    monkeypatch.setattr(agent_serve, "_driver_cls", lambda _source: _PlainDriver)
    message = _Message()

    assert await answer_one(engine, message, source=SOURCE) is True

    assert message.calls == [("reply", "re: Hello, whats our status")]
