"""LIVE: the blocks snippet, verbatim shape — receive, agent turn, reply.

The conversation's canonical program, run for real:

    async with workflow("blocks-e2e"):
        inbox  = Inbox(watched, api_key=KEY)
        agent = await get_agent("email-summarizer")
        async with agent.process_messages():
            async for m in inbox.listen():
                out   = await agent.process_message(m)
                reply = EmailMessageSpec.reply_to(m, body=out.text)
                await inbox.send(reply)

Everything is the shipped machinery: the agentmail driver fetches and sends,
the projection places messages, the persona spawns through its Deployment and
answers with a real worker turn. The test seeds one probe mail, lets the loop
answer it, verifies the reply ARRIVED at the counterpart inbox via the
provider's API, and checks the sent copy converges into the same conversation.

Needs (skips otherwise): DEEP_TESTING, AGENTMAIL_API_KEY, and
AGENTMAIL_PROBE_INBOX (an existing inbox on the same account — the plan's
inbox cap is 3 and the hub holds a slot, so only ONE transient inbox is
created here and deleted in ``finally``). A launchable Claude is required for
the agent turn, so this module is listed in ``_REAL_HOME_TEST_MODULES``.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
import uuid

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.blocks import EmailMessageSpec, Inbox, workflow
from flow_sdk.builtin.agent_registry import get_agent
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


def _probe_messages() -> list[dict]:
    return _api("GET", f"/inboxes/{urllib.parse.quote(PROBE)}/messages").get("messages") or []


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_blocks_snippet_receives_and_replies(local_project):
    # local_project seeds the @local Project a live instance owns at boot —
    # in-process there is no backend, and without it the deployment cannot
    # resolve a workdir (headless prompt FAILs with "workdir is not set").
    t0 = time.perf_counter()

    def mark(label: str) -> None:
        # Leg timing on stdout — pytest shows captured output on failure, so a
        # timeout names the leg that spent the budget instead of a bare stack.
        print(f"[{time.perf_counter() - t0:6.2f}s] {label}", flush=True)

    marker = f"blocks-{uuid.uuid4().hex[:8]}"
    created = _api("POST", "/inboxes", {"username": f"flowpad-blk-{marker[-8:]}"})
    watched = created.get("inbox_id") or created.get("address")
    assert watched, f"inbox create returned no address: {sorted(created)}"
    mark("inbox created")

    try:
        # ── seed: the outside correspondent writes in ────────────────────────
        _api("POST", f"/inboxes/{urllib.parse.quote(PROBE)}/messages/send", {
            "to": [watched],
            "subject": f"Probe {marker}",
            # One sentence, no tools: the persona will happily spend 15s
            # "creating an acknowledgment file" otherwise — measured.
            "text": f"Reply with one short sentence acknowledging probe {marker}. "
                    "Do not create files or use tools.",
        })
        mark("probe mail sent")

        # ── the snippet, verbatim shape ──────────────────────────────────────
        async with workflow("blocks-e2e"):
            inbox = Inbox(watched, api_key=KEY)
            agent = await get_agent("email-summarizer")
            assert agent is not None

            async with agent.process_messages():
                async for m in inbox.listen():
                    mark("received (listen yielded)")
                    assert marker in m.name, f"unexpected message: {m.name!r}"
                    assert m.thread_key, "AgentMail supplies a native thread id"

                    out = await agent.process_message(m)  # real worker turn
                    mark("turn captured")
                    assert out.text.strip(), "the turn produced no reply text"

                    reply = EmailMessageSpec.reply_to(
                        m, body=f"{out.text}\n[{marker}-reply]"
                    )
                    sent_id = await inbox.send(reply)
                    mark("reply sent")
                    assert sent_id, "the provider must confirm the send"
                    break                                          # one message is the test

        # ── the reply really arrived at the counterpart ──────────────────────
        reply_marker = f"{marker}-reply"
        # Inner budget sized to the measurement (verified at 2.4s live) and
        # bounded WELL inside the test's 30s cap — never a hidden extension.
        deadline = time.monotonic() + 15
        delivered = None
        while time.monotonic() < deadline and delivered is None:
            for msg in _probe_messages():
                if reply_marker in (msg.get("preview") or ""):
                    delivered = msg
                    break
            if delivered is None:
                await asyncio.sleep(2)
        mark("verified at probe" if delivered else "verification timeout")
        assert delivered is not None, "reply never arrived in the probe inbox"
        assert watched in str(delivered.get("from") or ""), "reply must come from the watched inbox"

        # Sent-copy convergence is deliberately NOT re-asserted here — it is
        # pinned by tests/long_tests/test_agentmail_roundtrip.py; this test's
        # budget belongs to the loop itself: receive → turn → send → verified.

    finally:
        _api("DELETE", f"/inboxes/{urllib.parse.quote(watched)}")
