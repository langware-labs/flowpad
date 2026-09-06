"""``docs/snippets/agent-helpdesk.md``, run as written with the hub legs stubbed.

The snippet's one verb is ``Agent.bind_channel`` — the same seam ``blocks.Inbox``
uses — so what is pinned is that the program compiles and that the bound source
is what the prose promises: provider ``helpdesk``, the desk in its config, owned
by the Agent.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source import DataSource
from tests.utils.snippets import compile_fence, doc, fences, run_fence

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"


async def test_the_agent_helpdesk_program_runs_verbatim(monkeypatch):
    import flow_sdk.auth

    async def login(*_a, **_k):
        return None

    monkeypatch.setattr(flow_sdk.auth, "login", login)
    source = fences(doc("agent-helpdesk.md"))[0]
    compile_fence(source, "agent-helpdesk.md")
    ns = await run_fence(source, {"DESK_PROJECT_ID": DESK}, filename="agent-helpdesk.md")

    desk: DataSource = ns["desk"]
    assert desk.provider == "helpdesk" and desk.channel == "helpdesk"
    assert str(desk.owner) == str(ns["support"].typeid)
    assert desk.inbound_allowed_senders in ([], None), "a desk is open unless someone is listed"
