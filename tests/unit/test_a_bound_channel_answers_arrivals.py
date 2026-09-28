"""A channel bound to an agent that is already running is answered from when it was bound.

The first sync of a new source reads the channel's backlog: messages written BEFORE the agent took
the channel, landing in ingest order AFTER the binding. They are history. The agent used to answer
them — found live, when one agent's run on every channel at once replied to the previous run's
messages (a Slack thread, a Telegram chat) the moment the new source first read them.
"""
from __future__ import annotations

import asyncio
import types
import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.stream_inbox.projection import reconcile_source
from tests.unit._stream_inbox_matrix import _stub_the_turn, double_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval


async def test_the_backlog_a_new_channel_first_reads_is_history_not_a_question(monkeypatch):
    from flow_sdk.builtin.agent_serve import hold_positions, serve, stop_serving

    with double_for("telegram") as double:
        agent = Agent(name=f"bound {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
        await agent.save()
        deployment = await agent.run_locally()  # the agent runs; the channel comes later
        _stub_the_turn(types.SimpleNamespace(nonce="n1"), monkeypatch)

        double.deliver("written before the agent took this chat", sender=double.sender)
        double.bot.updates[-1]["message"]["date"] -= 60  # a minute before the binding, as a backlog is
        monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", double.credentials)
        source = make_data_source(
            "telegram", name=f"bound telegram {uuid.uuid4().hex[:6]}", config=dict(double.config), owner=agent.typeid,
            status=SourceStatus.ACTIVE.value, allowed_senders=[double.sender], **dict(double.fields),
        )
        await source.save()  # bound now
        await sync_source(source)  # its first read: the backlog lands after the binding
        await reconcile_source(str(source.id))

        await hold_positions(deployment, [source])
        loop = asyncio.get_running_loop().create_task(serve(agent, deployment, sources=[source], poll_every=0.02))
        try:
            double.deliver("a question after the agent took it", sender=double.sender)
            await sync_source(source)
            for _ in range(200):
                if double.sent():
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.2)  # ten more cycles: time to (wrongly) answer the backlog too
        finally:
            await stop_serving(loop)

        answered = double.sent()
        assert len(answered) == 1, f"answered {len(answered)} messages, the backlog included: {answered}"
