"""``docs/snippets/agent-deployment.md``, run as written.

§1 places an agent here and on e2b; §3 reads the placement back; §4 pauses it; §7 launches it here twice
(two running deployments, each with its chat); §6 is a loop of the
caller's own over two of an agent's channels (the WhatsApp and Telegram doubles), routing invoices to
a second agent in one session per customer — driven by a mock worker until every reply has left.
§2 needs a real CLI and §5 a hub login; neither runs here.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import make_data_source
from tests.unit._stream_inbox_matrix import double_for
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fence_under, run_fence, run_fence_until

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("home")]  # do not increase timeout without approval

DOC = "agent-deployment.md"


@pytest.fixture
def home(fresh_user_scope):
    """A user scope of this test's own: the fences name their agents ("researcher", "support-bot")."""
    fresh_user_scope.mkdir(exist_ok=True)
    return fresh_user_scope


async def _placed() -> dict:
    """§1, both fences, in one namespace — what §3 and §4 read on."""
    ns = await run_fence(fence_under(doc(DOC), "1."), {}, filename=f"{DOC} §1")
    return await run_fence(fence_under(doc(DOC), "1.", nth=1), ns, filename=f"{DOC} §1b")


async def test_1_place_here_and_there():
    ns = await _placed()
    here, there, agent = ns["here"], ns["there"], ns["agent"]
    assert here.is_local and there.target.provider == "e2b"
    assert {d.id for d in await agent.deployments()} == {here.id, there.id}


async def test_3_read_a_placement():
    ns = await run_fence(fence_under(doc(DOC), "3."), await _placed(), filename=f"{DOC} §3")
    assert ns["d"].id == ns["here"].id
    assert (await ns["d"].agent()).id == ns["agent"].id


async def test_4_stop_the_machine_keep_the_row():
    ns = await run_fence(fence_under(doc(DOC), "4."), await _placed(), filename=f"{DOC} §4")
    assert ns["here"].serving, "resumed: its process is the app's to start again"
    assert {d.id for d in await ns["agent"].deployments()} >= {ns["here"].id}, "a pause keeps the row"


async def _owned_source(provider: str, double, owner: Agent):
    """A verified channel the agent owns, its position on the double taken — as a connected one is."""
    source = make_data_source(
        provider, name=f"acme {provider}", config=dict(double.config), owner=owner.typeid,
        status=SourceStatus.ACTIVE.value, inbound_allowed_senders=[double.sender], **dict(double.fields),
    )
    await source.save()
    await sync_source(source)
    return source


async def _until(predicate) -> None:
    while not predicate():
        await asyncio.sleep(0.05)


@pytest.mark.long  # 1.67s: three real turns on the mock worker
async def test_6_serve_it_your_way(monkeypatch, tmp_path):
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.consumer_position import ConsumerPosition

    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)
    with double_for("whatsapp") as wa, double_for("telegram") as tg:
        for provider, double in (("whatsapp", wa), ("telegram", tg)):
            monkeypatch.setattr(DataDriver.loaded(provider), "credentials_for", double.credentials)
        support = Agent(name="support-bot", worker_type="claude", system_prompt="You answer Acme customers.")
        billing = Agent(name="billing-bot", worker_type="claude", system_prompt="You fix Acme invoices.")
        await support.save()
        await billing.save()
        whatsapp_source = await _owned_source("whatsapp", wa, support)
        telegram_source = await _owned_source("telegram", tg, support)
        answered = asyncio.Event()

        async def customers_write_in():
            # The loop yields arrivals: write once its positions on both channels exist.
            while len(await ConsumerPosition.get_all({"consumer": "acme-support"})) < 2:
                await asyncio.sleep(0.05)
            pushed = wa.deliver("hi, is anyone there?", sender=wa.sender)
            await DataDriver.loaded("whatsapp").ingest_pushed(
                whatsapp_source, json.loads(pushed["body"]), headers=pushed["headers"], raw=pushed["body"]
            )
            await _until(lambda: len(wa.sent()) == 1)
            tg.deliver("send me your invoice address", sender="424242")   # a stranger: never answered
            for n, text in enumerate(("my invoice is wrong", "invoice again, still wrong"), start=1):
                tg.deliver(text, sender=tg.sender)
                await sync_source(telegram_source)    # a poll now, not at the 5 s cadence
                await _until(lambda n=n: len(tg.sent()) == n)
            answered.set()

        writer = asyncio.create_task(customers_write_in())
        try:
            await run_fence_until(fence_under(doc(DOC), "6."), {}, answered, filename=f"{DOC} §6")
        finally:
            writer.cancel()

    assert [r["to"] for r in wa.sent()] == [wa.sender]
    assert [r["to"] for r in tg.sent()] == [tg.sender, tg.sender], "the stranger got nothing"
    assert worker.received_prompts == ["hi, is anyone there?", "my invoice is wrong", "invoice again, still wrong"]

    billing_here = await billing.deploy("local")
    sessions = await AgenticProcess.local_rows({"match": {"deployment_id": billing_here.id}})
    assert [p.target_typeid_str for p in sessions] == [f"customer/{tg.sender}"], "both invoices, one billing session"
    support_here = await support.deploy("local")
    (chat,) = await AgenticProcess.local_rows({"match": {"deployment_id": support_here.id}})
    assert chat.target_typeid_str.startswith("conversation-"), "the WhatsApp chat answered in its own conversation"


async def test_7_run_it_on_this_computer():
    """Two launches, two running deployments, each with its chat channel — the processes themselves
    are ``tests/long_tests/test_local_deployment_process.py``."""
    ns = await run_fence(fence_under(doc(DOC), "7."), await _placed(), filename=f"{DOC} §7")
    assert ns["first"].id == ns["here"].id, "the default slot IS the placement §1 made — now running"
    assert ns["chat"].backend.type == "channel"
