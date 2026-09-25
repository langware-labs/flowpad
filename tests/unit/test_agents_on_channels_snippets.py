"""``docs/snippets/agents-on-channels.md``, run as written against the WhatsApp double.

§1 declares the credential; §2 (variant A) leaves an agent-owned, verified source that the agent's
running local deployment answers on the channel; §3 (variant B) is the loop, driven by a mock worker until its first reply leaves through
the channel. The Docker proof of §3 is ``tests/long_tests/test_whatsapp_agent_in_docker.py``.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from tests.unit._stream_inbox_matrix import double_for
from tests.utils.mock_worker import MockDriver
from tests.utils.snippets import doc, fence_under, run_fence, run_fence_until

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("home")]  # do not increase timeout without approval

DOC = "agents-on-channels.md"


@pytest.fixture
def home(sod_env, fresh_user_scope):
    """The user scope, on a temp folder that exists: a credential declared there is a folder asset."""
    fresh_user_scope.mkdir(exist_ok=True)
    return fresh_user_scope


@pytest.fixture
def whatsapp(monkeypatch):
    with double_for("whatsapp") as double:
        monkeypatch.setattr(DataDriver.loaded("whatsapp"), "credentials_for", double.credentials)
        yield double


def _names(double) -> dict:
    return {
        "WHATSAPP_TOKEN": double.secrets["access_token"], "WHATSAPP_APP_SECRET": double.secrets["app_secret"],
        "PHONE_NUMBER_ID": double.config["phone_number_id"], "VERIFY_TOKEN": double.config["verify_token"],
        "CUSTOMER": double.sender, "EXTRA_CONFIG": {"base_url": double.config["base_url"]},
    }


async def _push(double, source, text: str) -> None:
    delivered = double.deliver(text, sender=double.sender)
    await DataDriver.loaded("whatsapp").ingest_pushed(source, json.loads(delivered["body"]), headers=delivered["headers"], raw=delivered["body"])


async def test_1_the_credential_is_declared_once(whatsapp):
    from flow_sdk.builtin.credential_status import credentials_status

    await run_fence(fence_under(doc(DOC), "1."), _names(whatsapp), filename=f"{DOC} §1")
    status = await credentials_status(None, "default")
    assert any(c.name == "whatsapp" and c.scope == "user" for c in status.credentials)


@pytest.mark.long  # 3.2s: a real turn on the mock worker waits out the transcript's 2s settle window
async def test_2_variant_a_the_app_answers_on_the_channel(whatsapp, monkeypatch, tmp_path):
    """Nothing of the owner's runs: the deployment's loop (``builtin/agent_loop`` — in the app a
    process of its own, here the same code as a task) answers a customer's message on the channel."""
    from flow_sdk.builtin.agent_loop import run
    from flow_sdk.builtin.deployment import Deployment

    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)
    ns = await run_fence(fence_under(doc(DOC), "2."), _names(whatsapp), filename=f"{DOC} §2")
    source, agent = ns["source"], ns["agent"]
    (deployment,) = [d for d in await Deployment.get_all({"match": {"parent_type_id": str(agent.typeid)}}) if d.serving]
    stop = asyncio.Event()
    loop = asyncio.create_task(run(deployment.id, stop=stop))
    try:
        assert ns["verdict"]["ready"] is True and source.status == "active"
        assert str(source.owner) == str(agent.typeid) and source.allowed_senders == [whatsapp.sender]
        from flow_sdk.builtin.agent_serve import answered_sources

        assert str(source.id) in {str(s.id) for s in await answered_sources(agent, deployment)}
        await _push(whatsapp, source, "is anyone there?")
        while not whatsapp.sent():
            await asyncio.sleep(0.05)
        assert worker.received_prompts == ["is anyone there?"]
        (reply,) = whatsapp.sent()
        assert reply["to"] == whatsapp.sender and reply["text"].startswith("Mock reply")
    finally:
        stop.set()  # what the process's SIGTERM does: the loop ends between turns
        await loop
        await source.delete()
        await agent.delete()


async def _items(source):
    from flow_sdk.builtin.source_item import SourceItem

    return await SourceItem.get_all({"data_source_id": str(source.id)})


@pytest.mark.long  # 2.6s: a real turn on the mock worker waits out the transcript's 2s settle window
async def test_3_variant_b_answers_on_the_channel(whatsapp, monkeypatch, tmp_path):
    worker = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: worker)
    answered = asyncio.Event()

    async def customer_writes_in():
        # The loop's source does not exist until the fence makes it; a customer writes once it does,
        # then waits for the answer to leave through the channel.
        while (source := await DataSource.find_for_account("whatsapp", "phone_number_id", whatsapp.config["phone_number_id"])) is None:
            await asyncio.sleep(0.05)
        await _push(whatsapp, source, "my order arrived cracked, what now?")
        while not whatsapp.sent():
            await asyncio.sleep(0.05)
        answered.set()

    writer = asyncio.create_task(customer_writes_in())
    try:
        await run_fence_until(fence_under(doc(DOC), "3."), _names(whatsapp), answered, filename=f"{DOC} §3")
    finally:
        writer.cancel()
    assert worker.received_prompts == ["my order arrived cracked, what now?"]
    (reply,) = whatsapp.sent()
    assert reply["to"] == whatsapp.sender and reply["text"].startswith("Mock reply")
