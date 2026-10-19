"""``docs/snippets/agent-email.md``, both fences run as written, in order.

The Hub is the one thing not here: ``flow_sdk.auth.login`` is stubbed and the mailbox backend is a
stateful double of the Hub's mailbox API (get / enable / configure / disable / delete), so
``allocate_mailbox`` and every mailbox verb run their own code. The mail is a ``ScriptedSource`` under
``cloud_email`` and the worker is the mock. The live leg is ``tests/hub_tests/test_agent_email_conversation.py``.
"""

from __future__ import annotations

import pytest

import flow_sdk
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_mailbox import AgentMailbox
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fences, run_fence, run_fence_until

pytestmark = [
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.usefixtures("fresh_user_scope"),
]


class _HubMailboxes:
    """The Hub's mailbox API as a double: one mailbox per agent, policy normalized the way the Hub does."""

    kind = "flowpad-hub"

    def __init__(self):
        self.rows: dict[str, dict] = {}

    async def get_mailbox(self, agent_id):
        return dict(self.rows[agent_id]) if agent_id in self.rows else None

    async def enable_mailbox(self, agent_id, **options):
        row = self.rows.setdefault(agent_id, {
            "typeid": f"agent_mailbox-{mint_uuid()}", "agent_typeid": f"agent-{agent_id}",
            "address": "pirate@hub.test", "display_name": "pirate", "provider": "agentmail",
            "provider_inbox_id": f"mbx-{mint_uuid()}", "allowed_senders": [], "filters": {},
        })
        row["status"] = "active"
        if "allowed_senders" in options:
            row["allowed_senders"] = [str(a).strip().lower() for a in options["allowed_senders"]]
        return dict(row)

    async def configure_mailbox(self, agent_id, settings):
        row = self.rows[agent_id]
        if "allowed_senders" in settings:
            row["allowed_senders"] = [str(a).strip().lower() for a in settings["allowed_senders"]]
        if "filters" in settings:
            row["filters"] = dict(settings["filters"])
        return dict(row)

    async def disable_mailbox(self, agent_id):
        self.rows[agent_id]["status"] = "disabled"
        return dict(self.rows[agent_id])

    async def delete_mailbox(self, agent_id):
        return self.rows.pop(agent_id, None) is not None


async def test_the_page_runs_as_written(monkeypatch, tmp_path):
    import asyncio

    from flow_sdk.builtin.data_driver import DataDriver
    from tests.unit._stream_inbox_matrix import double_for

    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)

    async def login():
        return {"user": "stub"}

    hub = _HubMailboxes()
    monkeypatch.setattr(flow_sdk.auth, "login", login)
    monkeypatch.setattr("flow_sdk.builtin.agent_mailbox_driver.get_agent_mailbox_driver", lambda *_a, **_k: hub)
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.hub_auth_available", lambda *_a, **_k: True)

    # The fence names its agent, and message-block.md names one "pirate" too: the page makes it afresh.
    for other in await Agent.get_all({"name": "pirate"}):
        await other.delete()

    loop, verbs = fences(doc("agent-email.md"))
    with double_for("cloud_email") as mail:       # the real cloud_email driver over an in-process mailbox
        monkeypatch.setattr(DataDriver.loaded("cloud_email"), "credentials_for", mail.credentials)
        mail.deliver("where is the treasure?", sender="captain@gmail.com", subject="Ahoy")
        answered = asyncio.Event()

        async def until_answered():
            while not mail.sent():
                await asyncio.sleep(0.02)
            answered.set()

        watcher = asyncio.create_task(until_answered())
        try:
            ns = await run_fence_until(loop, {}, answered, filename="agent-email.md")
        finally:
            watcher.cancel()
        assert worker.received_prompts == ["where is the treasure?"]
        assert isinstance(ns["allocated"], AgentMailbox) and ns["pirate"].mailbox.address == "pirate@hub.test"

        ns = await run_fence(verbs, ns, filename="agent-email.md#verbs")   # the mailbox's own verbs, in order
    assert hub.rows == {}, "release() deletes the Hub's mailbox"
