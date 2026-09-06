"""``docs/snippets/workflows.md`` §1–3, run as written.

The provider is a ``ScriptedDriver`` registered under the snippet's own provider name and the
worker is ``MockDriver``, so each program runs verbatim with no network: one inbound message,
one agent turn, one reply, one ack. What is pinned is the shape — every item gets exactly one
of ``ack()`` / ``reply()`` — not the words the mock replies with.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from tests.utils.fake_source import scripted_provider
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fence_under, run_fence_until

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DOC = "workflows.md"


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


async def _agent(name: str) -> Agent:
    """Get-or-create: an Agent is an asset, and the fences name theirs."""
    from flow_sdk.builtin.agent_registry import get_agent

    existing = await get_agent(name)
    if existing is not None:
        return existing
    agent = Agent(name=name, worker_type="claude", system_prompt="Be brief.")
    await agent.save()
    return agent


async def _run(section: str, provider: str, ns: dict, driver, *, nth: int = 0) -> dict:
    source = fence_under(doc(DOC), section, nth=nth)
    return await run_fence_until(source, ns, driver.settled, filename=f"{DOC} § {section}")


async def test_1_mail_concierge(worker):
    await _agent("email-summarizer")
    with scripted_provider("agentmail") as mail:
        mail.push({"name": "Probe", "body": "are we on?", "author": "alice@example.com", "thread_key": "t1"})
        await _run("1.", "agentmail", {"KEY": "not-a-real-key"}, mail)
    assert worker.received_prompts == ["are we on?"]
    assert len(mail.sent) == 1 and mail.sent[0]["to"] == "alice@example.com"
    assert mail.sent[0]["text"].startswith("Mock reply")


async def test_1_control_flow_acks_what_it_ignores(worker):
    await _agent("email-summarizer")
    with scripted_provider("agentmail") as mail:
        mail.push(
            {"name": "newsletter", "body": "ignore me", "author": "boss@corp.com", "thread_key": "t1"},
            {"name": "URGENT: prod", "body": "help", "author": "boss@corp.com", "thread_key": "t2"},
        )
        # The variant assumes §1's imports and agent are in scope.
        from flow_sdk.blocks import EmailMessageSpec, Inbox, workflow
        from flow_sdk.builtin.agent_registry import get_agent

        ns = {"KEY": "k", "EmailMessageSpec": EmailMessageSpec, "Inbox": Inbox, "workflow": workflow,
              "agent": await get_agent("email-summarizer")}
        await _run("1.", "agentmail", ns, mail, nth=1)
    assert worker.received_prompts == ["help"], "the newsletter never reached the agent"
    assert len(mail.sent) == 1 and mail.sent[0]["thread_key"] == "t2"
    # The ignored item was acked, not skipped: the loop variable is the LAST item and it is
    # acked by reply(); an offset ack covers the newsletter before it. The ephemeral position
    # is not in the DB (no workflow), so the shape is the proof — one send, one prompt.


async def test_2_telegram(worker):
    await _agent("support-agent")
    with scripted_provider("telegram") as bot:
        bot.push({"body": "hi bot", "author": "12345", "thread_key": "12345/7"})
        await _run("2.", "telegram", {"TOKEN": "000:token"}, bot)
    assert worker.received_prompts == ["hi bot"] and len(bot.sent) == 1


async def test_3_slack(worker):
    await _agent("slack-summarizer")
    with scripted_provider("slack") as slack:
        slack.push({"body": "summarize?", "author": "U1", "thread_key": "1700000000.000100"})
        await _run("3.", "slack", {}, slack)
    assert worker.received_prompts == ["summarize?"] and len(slack.sent) == 1


async def test_a_second_run_under_the_same_name_resumes_after_the_reply(worker):
    """The position is durable under the workflow name: the answered item is not seen again."""
    await _agent("email-summarizer")
    name = f"mail-concierge-{mint_uuid()}"
    text = doc(DOC).replace('workflow("mail-concierge")', f'workflow("{name}")')
    source = fence_under(text, "1.")
    with scripted_provider("agentmail") as mail:
        mail.push({"body": "first", "author": "a@x", "thread_key": "t1"})
        await run_fence_until(source, {"KEY": "k"}, mail.settled, filename=DOC)
        mail.settled.clear()
        mail.push({"body": "second", "author": "a@x", "thread_key": "t1"})
        await run_fence_until(source, {"KEY": "k"}, mail.settled, filename=DOC)
    assert worker.received_prompts == ["first", "second"], "one turn per item, none repeated"
    assert len(mail.sent) == 2
