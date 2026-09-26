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
    """§1, both fences, in one namespace — what §3 and §4 read on. The session's test DB holds any
    "researcher" an earlier test placed; the fences find theirs by name, so exactly one must answer."""
    from flow_sdk.builtin.agent import Agent

    for other in await Agent.get_all({"name": "researcher"}):
        await other.delete()
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
        status=SourceStatus.ACTIVE.value, allowed_senders=[double.sender], **dict(double.fields),
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


async def test_2_start_a_session_on_a_placement(mock_driver, tmp_path):
    """§2, every fence as written, on §1's placements: launch here, refused there, a session, a draft."""
    from flow_sdk.builtin.project import Project

    mock_driver(lambda turn: "Three sources.")
    (tmp_path / "other").mkdir()
    other = Project(name="other", fs_storage_mount_path=str(tmp_path / "other"))
    await other.save()
    ns = await _placed()
    ns["OTHER_PROJECT"] = str(other.id)
    for nth in range(4):
        ns = await run_fence(fence_under(doc(DOC), "2.", nth=nth), ns, filename=f"{DOC} §2[{nth}]")
        if nth == 1:
            assert ns["answer"].exit_code.name == "NOT_APPLICABLE" and ns["answer"].ran is False
    assert ns["draft"].context_data["instructions"]


async def test_5_a_machine_of_its_own(monkeypatch):
    """§5 as written; the hub's legs — publish the agent, boot its machine — answered by a double."""
    import flow_sdk.auth
    from flow_sdk.builtin import cloud_deploy
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    await _placed()
    await get_or_create_local_user()
    published: list = []

    async def login(*_a, **_k):
        return None

    async def ensure_on_hub(self, actor, *, force=False):
        published.append((self.name, str(actor)))
        return True

    async def deploy(entity, environment=None):
        return {"deployment_id": "dep-1", "entity": entity.name, "environment": environment or "production"}

    monkeypatch.setattr(flow_sdk.auth, "login", login)
    monkeypatch.setattr(Agent, "ensure_on_hub", ensure_on_hub)
    monkeypatch.setattr(cloud_deploy, "deploy_entity_to_cloud", deploy)
    ns = await run_fence(fence_under(doc(DOC), "5."), {}, filename=f"{DOC} §5")
    assert published == [("researcher", str(ns["actor"]))], "publish comes first, as the caller"
    assert ns["receipt"]["entity"] == "researcher"


async def test_7_the_shown_loop_is_the_shipped_one():
    """§7's second fence quotes the stock loop: it is that function's code (its docstring aside), and it
    defines as written."""
    import ast
    import inspect

    from flow_sdk.builtin.deployment_loop import answer_every_message

    def code(source: str) -> str:
        fn = ast.parse(source).body[0]
        if ast.get_docstring(fn) is not None:
            fn.body = fn.body[1:]
        return ast.dump(fn)

    fence = fence_under(doc(DOC), "7.", nth=1)
    assert code(fence) == code(inspect.getsource(answer_every_message)), "the page shows the shipped loop"
    ns = await run_fence(fence, {}, filename=f"{DOC} §7b")
    assert callable(ns["answer_every_message"])
