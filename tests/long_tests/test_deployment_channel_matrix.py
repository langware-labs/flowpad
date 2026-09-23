"""Every message channel, answered by a REAL local deployment process.

A real backend (``live_backend``) runs agent deployments as processes; each cell is one channel:
its driver's ``Double`` (a loopback provider), its auth planted in the instance the way a person's
would be (``tests/e2e/channel_doubles.py`` — the vault, the connection store, an env file), a source
the agent owns, and ``agent.run_locally()`` running the stock loop on the mock worker. Then:

* a message from a stranger, then one from the allowed sender, arrive (a webhook into the backend,
  or the process's own poll);
* the allowed one is answered on the channel by a process of THIS deployment — the stranger never;
* the backend did not sync the source while the process held it.

Nothing is monkeypatched across the process boundary: what the process reads is what a person's
machine would hold.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.ingest.testing import make_data_source
from tests.long_tests._deployments import WRAPPER, agent, end, ready, run, until

pytestmark = [pytest.mark.timeout(90)]  # do not increase timeout without approval

STRANGER = "stranger"


@pytest.fixture
def doubles(deployments_backend, tmp_path, request):
    from tests.e2e.channel_doubles import Doubles

    (tmp_path / "doubles").mkdir()
    hosted = Doubles(deployments_backend, tmp_path / "doubles", channels=(request.param,))
    hosted.start()
    try:
        yield hosted
    finally:
        hosted.stop()


def _owned(doubles, owner, provider: str, **extra) -> DataSource:
    """The agent's source on *provider*: the Double's config and auth, its sender allowed."""
    entry = doubles.channels()[provider]
    source = make_data_source(
        provider, name=f"{provider} {uuid.uuid4().hex[:6]}", config=dict(entry["config"]), owner=owner.typeid,
        status=SourceStatus.ACTIVE.value, inbound_allowed_senders=[entry["sender"]], **entry["fields"], **extra,
    )
    if entry.get("secret_store"):
        source.secret_store = entry["secret_store"]
    run(source.save())
    return source


def _turns(deployment) -> list:
    return run(AgenticProcess.local_rows({"match": {"deployment_id": deployment.id}}))


def _backend_log(tmp_path) -> str:
    log = tmp_path / "backend.log"
    return log.read_text(errors="replace") if log.exists() else ""


@pytest.mark.long  # ~15s a cell: a real backend boot, a deployment process, a turn on the mock worker
@pytest.mark.parametrize("doubles", ["whatsapp", "waha", "telegram", "slack", "teams", "gmail", "agentmail"], indirect=True)
def test_a_deployment_process_answers_the_channel(doubles, tmp_path):
    (provider,) = doubles.doubles
    sender = doubles.channels()[provider]["sender"]
    owner = agent(f"matrix-{provider}")
    source = _owned(doubles, owner, provider)
    deployment = run(owner.run_locally(snippet=WRAPPER))
    try:
        log = ready(deployment, 2)
        held_from = len(_backend_log(tmp_path))  # from here on the process holds the source

        doubles.deliver(provider, "from a stranger", STRANGER)
        delivered = doubles.deliver(provider, f"hello {provider}", None)
        until(f"a reply on {provider} ({log.read_text()[-1500:]})", lambda: doubles.sent(provider), within=45)
        time.sleep(1)  # a second reply (to the stranger) would land by now — it must not
        (reply,) = doubles.sent(provider)

        assert reply["text"].startswith("Mock reply"), reply
        # Answered where it was asked: to the sender, or in the thread it arrived on (a Slack channel).
        to_sender = str(sender).lower() in str(reply["to"]).lower()
        in_its_thread = bool(delivered.get("thread")) and str(reply.get("thread")) == str(delivered["thread"])
        assert to_sender or in_its_thread, (reply, delivered)
        assert _turns(deployment), "the turn ran in a process of THIS deployment"

        # Ask the backend to poll it now: a driver with a fast lane is polled at once — unless held.
        asked = httpx.post(f"{doubles.backend}/api/v1/graph/data_source/{source.id}/request_poll", timeout=10)
        asked.raise_for_status()
        if (asked.json().get("data") or {}).get("attention_seconds"):
            until("the backend to leave the source to the process",
                  lambda: f"{source.id} is held by a running deployment" in _backend_log(tmp_path), within=10)
        synced_here = f"[ingest] {provider}/{source.name} "
        assert synced_here not in _backend_log(tmp_path)[held_from:], "the backend synced a source its process holds"
    finally:
        end(deployment)
        if run(DataSource.get_by_id(source.id)) is not None:
            run(source.delete())


@pytest.mark.long  # ~10s: a real backend boot, a deployment process, a turn on the mock worker
def test_a_deployment_process_takes_its_tasks_channel(deployments_backend):
    """The Tasks channel is fed by the backend's own bus (``task.*``); the process drains it. Its
    turns reply explicitly, so the check is the turn — taken by THIS deployment — and that nothing
    was sent on the channel by itself."""
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.tasks.cos import sync_tasks_channel

    chief = agent("chief", chief_of_staff=True)
    channel = run(sync_tasks_channel(chief))
    assert channel is not None, "a Chief of Staff has a Tasks channel"
    deployment = run(chief.run_locally(snippet=WRAPPER))
    try:
        log = ready(deployment, 2)
        api = f"{deployments_backend}/api/v1/tasks"
        made = httpx.post(api, json={"title": "Check the numbers", "brief": "Q3", "owner": f"agent:{chief.id}"}, timeout=20).json()
        assert made.get("status") == "SUCCESS", made
        replied = httpx.post(f"{api}/{made['data']['id']}/reply", json={"text": "Use the October sheet."}, timeout=20).json()
        assert replied.get("status") == "SUCCESS", replied

        def rows():
            return run(SourceItem.get_all({"data_source_id": str(channel.id)}))

        until("the task's events on the agent's Tasks channel", lambda: len(rows()) >= 2, within=20)
        until(f"the reply to be taken by the deployment ({log})", lambda: _turns(deployment), within=45)
        time.sleep(1)
        assert not [r for r in rows() if (r.body or "").startswith("Mock reply")], (
            "a Tasks turn replies explicitly — its text is not sent back by itself"
        )
    finally:
        end(deployment)


@pytest.mark.long  # ~15s: a real backend boot, two deployment processes, one turn
@pytest.mark.parametrize("doubles", ["whatsapp"], indirect=True)
def test_a_channel_pinned_to_the_second_deployment_is_answered_only_there(doubles):
    owner = agent("pinned")
    first = run(owner.run_locally(snippet=WRAPPER))
    second = run(owner.run_locally(snippet=WRAPPER))
    _owned(doubles, owner, "whatsapp", answer_place=second.id)
    try:
        ready(first, 1)   # its chat only — the WhatsApp channel names the second
        ready(second, 2)
        doubles.deliver("whatsapp", "who answers?", None)
        until("the reply", lambda: doubles.sent("whatsapp"), within=45)
        assert _turns(second)
        assert not _turns(first), "the first never takes it"
    finally:
        end(first, second)


@pytest.mark.long  # ~20s: a real backend boot, a process stopped and started again, one turn
@pytest.mark.parametrize("doubles", ["whatsapp"], indirect=True)
def test_a_message_that_arrives_while_paused_is_answered_after_resume(doubles):
    owner = agent("paused")
    _owned(doubles, owner, "whatsapp")
    deployment = run(owner.run_locally(snippet=WRAPPER))
    try:
        ready(deployment, 2)
        assert run(run(Deployment.get_by_id(deployment.id)).pause()) is True
        assert not deployment_process.alive(run(Deployment.get_by_id(deployment.id))), "a pause ends the process"

        delivered = doubles.deliver("whatsapp", "are you there?", None)
        assert delivered.get("webhook_status") == 200, delivered  # the backend takes it in while nobody answers
        time.sleep(2)
        assert doubles.sent("whatsapp") == [], "paused: nobody answers"

        assert run(run(Deployment.get_by_id(deployment.id)).resume()) is True
        (reply,) = until("the reply after resume", lambda: doubles.sent("whatsapp"), within=45)
        assert reply["text"].startswith("Mock reply: are you there?")
    finally:
        end(deployment)
