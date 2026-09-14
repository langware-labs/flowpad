"""The ``agent`` data source over a scripted harness worker: the connector is the channel, the
worker records (a traversal returns no items), the receipt's high-water is the cursor, and a send
reports a draft, a recorded copy and a deliverable honestly."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped sources
from flow_sdk.ingest.driver import SegmentCursorView, SendStatus, get_driver
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import Unsupported
from flow_sdk.sources.protocols import Messaging
from flow_sdk.sources.providers.agent import AgentSource
from flow_sdk.sources.testing import Subject, checks_for

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


class _Worker:
    """A harness worker that answers what it is told and remembers every run."""

    def __init__(self, receipt=None, outcome=None):
        self.receipt = receipt if receipt is not None else {"count": 2, "high_water": "2026-09-01T10:00:00+00:00"}
        self.outcome = outcome if outcome is not None else {"external_id": "m-1", "drafted": False, "recorded": True, "artifact_id": "art-1"}
        self.fetches, self.sends = [], []

    async def fetch(self, **run):
        self.fetches.append(run)
        return dict(self.receipt)

    async def send(self, **run):
        self.sends.append(run)
        return dict(self.outcome)


@pytest.fixture
def worker(monkeypatch):
    fake = _Worker()
    monkeypatch.setattr(get_driver("agent"), "_build", lambda binding: AgentSource(binding, worker=fake))
    return fake


def _row(**config):
    return SimpleNamespace(id="ds-agent", provider="agent", name="Gmail via agent", account_key="", account_identities=[],
                           config={"connector": "gmail", "harness": "claude", **config})


def _view(state=None, key="INBOX"):
    return SegmentCursorView(segment_key=key, state=state or {}, window_start=None, first_run=not state)


@pytest.mark.parametrize("check", [c for c in checks_for(AgentSource) if c.requires is not Messaging], ids=str)
async def test_conformance_beyond_messaging(check):
    """The harness transport's addressing is a thread plus an address, pinned by its own send tests
    below; every other clause the kit checks, it passes."""
    binding = SourceBinding(source_id="ds-agent", config={"connector": "gmail"})
    await check.run(Subject(source=lambda: AgentSource(binding, worker=_Worker())))


def test_the_connector_is_the_channel():
    assert get_driver("agent").channel_for(_row()) == "gmail"
    assert get_driver("agent").channel_for(_row(connector="slack")) == "slack"


async def test_the_worker_records_so_a_traversal_returns_no_items(worker):
    result = await get_driver("agent").fetch(_row(), _view())
    assert result.items == [] and result.next_state == {"cursor": AgentSource.resume_after("2026-09-01T10:00:00+00:00")}
    assert worker.fetches[0]["segment_key"] == "INBOX" and worker.fetches[0]["since"] == ""


async def test_the_receipts_high_water_is_the_next_runs_floor(worker):
    await get_driver("agent").fetch(_row(), _view({"high_water": "2026-08-31T00:00:00+00:00"}))
    assert worker.fetches[0]["since"] == "2026-08-31T00:00:00+00:00", "a legacy cursor is adopted"


@pytest.mark.parametrize("reported,health", [("no_connector", SourceHealth.CONFIG_ERROR), ("imap_hiccup", SourceHealth.TRANSIENT_ERROR)])
async def test_a_reported_error_classifies_by_what_fixes_it(worker, reported, health):
    worker.receipt = {"error": reported}
    with pytest.raises(Exception) as caught:
        await get_driver("agent").fetch(_row(), _view())
    assert classify(caught.value)[0] is health


async def test_a_send_carries_the_thread_the_address_and_the_local_conversation(worker):
    out = await get_driver("agent").send(_row(), thread_key="t-1", to="a@b.c", text="hi", subject="Re: x", conversation_id="conv-1")
    run = worker.sends[0]
    assert (run["thread_key"], run["to"], run["subject"], run["conversation_id"], run["channel"]) == ("t-1", "a@b.c", "Re: x", "conv-1", "gmail")
    assert (out.external_id, out.status, out.recorded, out.artifact_id) == ("m-1", SendStatus.SENT, True, "art-1")


async def test_a_draft_is_reported_as_a_draft_and_never_recorded(worker):
    worker.outcome = {"external_id": "r-1", "drafted": True, "recorded": False, "artifact_id": ""}
    out = await get_driver("agent").send(_row(), thread_key="t-1", to="a@b.c", text="hi")
    assert (out.drafted, out.external_id, out.recorded) == (True, "r-1", False)


async def test_a_reply_by_message_is_declared_unsupported():
    source = AgentSource(SourceBinding(config={"connector": "gmail"}), worker=_Worker())
    async with source:
        with pytest.raises(Unsupported):
            await source.reply(source.origin("m-1", "INBOX"), None)  # type: ignore[arg-type]
