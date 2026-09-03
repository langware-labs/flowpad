"""``docs/snippets/agent-email.md``, run as written with the Hub legs stubbed.

``flow_sdk.auth.login`` and ``Agent.enableEmail`` reach the Hub; here they answer a fake
allocation. The mail is a ``ScriptedDriver`` under ``cloud_email`` and the worker is the mock.
The live leg is ``tests/hub_tests/test_agent_email_conversation.py``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import flow_sdk
from flow_sdk.builtin.agent import Agent
from tests.utils.fake_source import scripted_provider
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fences, run_fence_until

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_the_agent_email_program_runs_verbatim(monkeypatch, tmp_path):
    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)

    async def login():
        return {"user": "stub"}

    monkeypatch.setattr(flow_sdk.auth, "login", login)

    allocation = SimpleNamespace(address="pirate@hub.test")

    async def enable_email(self):
        object.__setattr__(self, "_inbox", allocation)     # `inbox` is a read-only view of it
        return allocation

    monkeypatch.setattr(Agent, "enableEmail", enable_email)

    # The fence names its agent, and an Agent is an asset on disk: two pages creating
    # "pirate" collide on the file, whichever order they run. Run this one under a name of
    # its own; the page on disk stays verbatim.
    from flow_sdk.api.api_types.identifier import mint_uuid

    agent_name = f"pirate-{mint_uuid()}"

    try:
        with scripted_provider("cloud_email") as mail:
            mail.push({"name": "Ahoy", "body": "where is the treasure?", "author": "captain@gmail.com", "thread_key": "t1"})
            (source,) = fences(doc("agent-email.md"))
            source = source.replace('name="pirate"', f'name="{agent_name}"')
            ns = await run_fence_until(source, {}, mail.settled, filename="agent-email.md")

        assert worker.received_prompts == ["where is the treasure?"]
        assert len(mail.sent) == 1 and mail.sent[0]["to"] == "captain@gmail.com"
        assert ns["pirate"].inbox is allocation
    finally:
        from flow_sdk.builtin.agent_registry import get_agent

        created = await get_agent(agent_name)
        if created is not None:
            await created.delete()
