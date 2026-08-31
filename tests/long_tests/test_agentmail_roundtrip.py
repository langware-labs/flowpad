"""LIVE: the AgentMail source, back and forth with the Flowpad inbox.

The pure-Python twin of the agent-transport live tests — no worker, no CLI, no
``live_backend``: the driver is in-process HTTP, so the whole loop (receive →
project → reply → verify at the provider → sent-copy convergence) runs in this
process against the session DB and takes tens of seconds, all of it provider
round trips.

Needs (skips otherwise, never fails, never invents):
- ``DEEP_TESTING`` on (house gate for live tests),
- ``AGENTMAIL_API_KEY`` in the environment,
- ``AGENTMAIL_PROBE_INBOX`` — an EXISTING inbox on the same account that plays
  the outside correspondent. The account's inbox cap is small (3 on the free
  plan) and one slot is typically held by the hub's live agent, so the test
  creates only ONE transient inbox (the watched one) and deletes it in
  ``finally`` rather than assuming two free slots.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.sync import sync_source
from tests.test_settings import test_service_config

KEY = os.environ.get("AGENTMAIL_API_KEY", "")
PROBE = os.environ.get("AGENTMAIL_PROBE_INBOX", "")
BASE = "https://api.agentmail.to/v0"

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.skipif(not KEY, reason="set AGENTMAIL_API_KEY"),
    pytest.mark.skipif(not PROBE, reason="set AGENTMAIL_PROBE_INBOX to an existing inbox address"),
]


def _api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        return json.loads(raw) if raw.strip() else {}


def _messages(inbox: str) -> list[dict]:
    return _api("GET", f"/inboxes/{urllib.parse.quote(inbox)}/messages").get("messages") or []


async def _sync(source: DataSource) -> None:
    await sync_source(source, now=datetime.now(timezone.utc))


async def _until(predicate, *, budget_s: int, every_s: float = 3.0):
    """Poll the provider until ``predicate`` answers, inside the test's budget.

    Not a timeout knob: the budget is the measured cost of one SES delivery
    (~30-60s observed live) and the test FAILS when it is spent — nothing here
    retries past the deadline.
    """
    deadline = time.monotonic() + budget_s
    while time.monotonic() < deadline:
        found = await predicate()
        if found is not None:
            return found
        await asyncio.sleep(every_s)
    raise AssertionError("provider round trip exceeded its measured budget")


@pytest.mark.asyncio
@pytest.mark.timeout(240)  # approved: three live SES deliveries at ~30-60s each, measured 2026-09-01
async def test_agentmail_roundtrip():
    marker = f"am-e2e-{uuid.uuid4().hex[:8]}"
    created = _api("POST", "/inboxes", {"username": f"flowpad-rt-{marker[-8:]}"})
    watched = created.get("inbox_id") or created.get("address")
    assert watched, f"inbox create returned no address: {sorted(created)}"
    try:
        source = DataSource(
            name="AgentMail roundtrip",
            provider="agentmail",
            config={"inbox": watched, "api_key": KEY},
        )
        await source.save()
        assert source.channel == "agentmail", "channel must be stamped at create"

        # ── receive: probe → watched → SourceItem → reference FlowMessage ──
        _api("POST", f"/inboxes/{urllib.parse.quote(PROBE)}/messages/send", {
            "to": [watched],
            "subject": f"Probe {marker}",
            "text": f"probe body {marker}",
        })

        async def _ingested():
            await _sync(source)
            items = await SourceItem.get_all({"data_source_id": source.id})
            return next((i for i in items if marker in (i.name or "")), None)

        item = await _until(_ingested, budget_s=90)
        assert item.kind == "content.message.email"
        assert item.thread_key, "AgentMail supplies a native thread id"

        # The tag lanes belong to the backend process; this test asserts the
        # projection's OUTPUT, not the bus — same stance as the Slack twin.
        from flow_sdk.inbox.projection import project_source_item  # noqa: PLC0415

        await project_source_item(item, source=source, notify=False, announce=False)
        fm = await FlowMessage.get_one({"source_item_id": item.id})
        assert fm is not None, "the projection must place the message"
        assert marker in (fm.text or ""), "reads hydrate from the item"
        raw = (await FlowMessage.get_all({"id": fm.id}, hydrate=False))[0]
        assert raw.text == "", "the stored row is a reference, not a copy"

        # ── reply: the driver's real send, threaded on the provider's id ──
        reply_marker = f"{marker}-reply"
        from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

        outcome = await get_driver("agentmail").send(
            source,
            thread_key=item.thread_key or "",
            to=item.author_external_id or PROBE,
            text=f"reply body {reply_marker}",
            in_reply_to=item.external_id or "",
        )
        assert outcome.external_id, "the provider must confirm the send"

        async def _delivered():
            for msg in _messages(PROBE):
                if reply_marker in (msg.get("preview") or ""):
                    return msg
            return None

        delivered = await _until(_delivered, budget_s=90)
        assert watched in str(delivered.get("from") or ""), "the reply must come from the watched inbox"

        # ── sent copy: the next poll ingests it into the SAME conversation ──
        async def _converged():
            await _sync(source)
            items = await SourceItem.get_all({"data_source_id": source.id})
            copy = next((i for i in items if reply_marker in (i.body or "")), None)
            if copy is None:
                return None
            await project_source_item(copy, source=source, notify=False, announce=False)
            return await FlowMessage.get_one({"source_item_id": copy.id})

        copy_fm = await _until(_converged, budget_s=60)
        assert copy_fm.conversation_id == fm.conversation_id, "the sent copy must not fork the thread"
    finally:
        _api("DELETE", f"/inboxes/{urllib.parse.quote(watched)}")
