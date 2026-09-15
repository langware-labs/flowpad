"""Messages that land together on an agent's channel are answered one turn at a time.

Found by sending five WhatsApp messages in a burst: the first became a turn, three were refused with
"another prompt turn is already in flight" and never answered, and the two turns that overlapped each
captured the LATEST reply and sent it twice. Every message is now its own turn, in arrival order.
"""
import asyncio
from types import SimpleNamespace

import pytest

import flow_sdk.inbox.agent_runner as runner
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


class _Worker:
    """A headless process: refuses a prompt while one is in flight; a turn's reply echoes its prompt."""

    def __init__(self) -> None:
        self.in_flight = False
        self.last = ""

    async def prompt(self, body: str):
        if self.in_flight:
            return ApiFailResponse(message="another prompt turn is already in flight for this process")
        self.in_flight, self.last = True, body
        return ApiSuccessResponse(data={"status": "started"})

    async def finish(self) -> str:
        await asyncio.sleep(0.05)  # the turn runs long enough for the next message to arrive
        self.in_flight = False
        return f"reply to {self.last}"


async def test_messages_arriving_together_each_get_their_own_turn(monkeypatch):
    worker, sent = _Worker(), []
    source = SimpleNamespace(id="ds-1")

    async def dispatch(conversation_id, *, text, source_id, item, source=None):
        sent.append(f"{text} (quoting {item.body})")
        return ApiSuccessResponse(data={})

    async def conversation_id_for(*_):
        return "conv-1"

    monkeypatch.setattr("flow_sdk.builtin.data_source.DataSource.get_one", classmethod(lambda cls, _q: _async(source)))
    monkeypatch.setattr(runner, "_is_own_outgoing", lambda *_: False)
    monkeypatch.setattr("flow_sdk.inbox.projection.owner_of", lambda _s: _async("agent-1"))
    monkeypatch.setattr(runner, "_agent_for", lambda _o: _async(SimpleNamespace(name="a", id="1")))
    monkeypatch.setattr(runner, "_admits", lambda *_: True)
    monkeypatch.setattr(runner, "_conversation_id_for", conversation_id_for)
    monkeypatch.setattr(runner, "_workdir_for", lambda _a: _async("/tmp"))
    monkeypatch.setattr(runner, "_reuse_or_spawn_agent_process", lambda *_: _async(worker))
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", lambda _ap: worker.finish())
    monkeypatch.setattr("flow_sdk.inbox.outbound.dispatch_channel_reply", dispatch)

    items = [SimpleNamespace(id=str(n), data_source_id="ds-1", author_external_id="972500000000", body=f"burst {n}") for n in range(1, 4)]
    results = await asyncio.gather(*(runner.handle_inbound(item) for item in items))

    assert results == [True, True, True]
    assert sent == [f"reply to burst {n} (quoting burst {n})" for n in range(1, 4)]


async def _async(value):
    return value
