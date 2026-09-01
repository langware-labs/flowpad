"""Allocate a REAL mailbox through the hub, use it, and give it back.

**This test spends money.** Provisioning allocates a genuine, permanent, publicly
writable address at the mail provider — the hub says so in four places, e.g.
``ServiceConfig.email_inbox_enabled``'s own comment ("a billable, permanent,
publicly writable address"). It is in
the hub tier precisely because of that: the tier auto-skips without a local hub
and is excluded from CI, so an address is only ever allocated when someone runs
this deliberately.

Teardown is a fixture finalizer rather than code at the end of the test, so a
failing assertion still releases the address. The two things it must tolerate,
both learned from the hub's own code rather than from a failure here:

  * a second ``DELETE`` answers **404**, not 200 — ``_run_inbox_op`` looks the
    inbox up before decommissioning and there is nothing to find the second time;
  * the row **survives** as ``status=deleted`` so past mail stays attributable,
    so "gone" is never "the row disappeared".

What it does NOT cover is publishing: the fixture puts the agent in the
already-published state (``remote`` + ``git_origin``), because ``ensure_on_hub``
is a Git commit-and-push needing a published Project and GitHub connected, and
this test is about the mailbox. Publishing has its own coverage.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver

from tests.hub_tests._local_login import login_as

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]


@pytest.fixture
async def published_agent(hub_base_url, hub_login_payload):
    """An agent the hub knows about, with its mailbox released afterwards.

    Creates the hub row directly (`POST /graph/agent`) — the hub's `Agent` is
    `_api_visible=True` with all `APIField`s, unlike `EmailInbox`, which is
    deliberately off the generic API so nothing but the `email_inbox` action can
    reach a mailbox.
    """
    token = login_as(hub_login_payload)
    agent_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=20) as client:
        created = await client.post(
            f"{hub_base_url}/api/v1/graph/agent",
            headers=headers,
            json={"id": agent_id, "name": f"inbox-test-{agent_id[:8]}", "worker_type": "claude"},
        )
        assert created.status_code < 400, f"could not create the hub agent: {created.text[:300]}"
        hub_id = (created.json().get("data") or {}).get("id") or agent_id

        # Local twin at the SAME id — local and hub rows share one id, which is
        # what `remote` already asserts. An `origin` makes `ensure_on_hub`
        # short-circuit at its own guard rather than trying to publish.
        agent = Agent(id=hub_id, name=f"inbox-test-{hub_id[:8]}")
        agent.remote = True
        # A STUB, shaped only to satisfy `ensure_on_hub`'s `remote and origin`
        # guard — not a meaningful GitOrigin. A real one carries
        # provider/owner/name/branch and its `key()` is the cross-machine dedup
        # handle, so do not copy this into a fixture where that key matters.
        # (The field is `origin`; `git_origin` is only its hub WIRE name.)
        agent.origin = {"rel_path": "agentic-assets/agent/inbox-test"}
        await agent.save()

        try:
            yield agent
        finally:
            # Release the address FIRST — it is the billable thing. This goes
            # through the real verb rather than a raw DELETE: `False` already
            # means "there was nothing to release", which is exactly the
            # tolerance a finalizer wants, and anything else still raises.
            await agent.decommission_inbox()
            gone = await client.request(
                "DELETE", f"{hub_base_url}/api/v1/graph/agent/{hub_id}", headers=headers, json={}
            )
            assert gone.status_code < 400, (
                f"LEAKED agent {hub_id}: {gone.status_code} {gone.text[:200]}"
            )
            # And the local twin: the tier's reclaimer only sweeps HUB rows, so
            # without this every run leaves a permanent local agent marked
            # remote with the stub origin above — exactly the half-published
            # shape the share/reconcile paths later trip over.
            await agent.delete()


async def test_a_real_mailbox_is_allocated_used_and_released(published_agent):
    """One round trip, deliberately ONE test.

    Every `provision` allocates a permanent, billable address, so this file
    spends one and asserts everything against it rather than splitting into
    three tests that each allocate their own and all read back the same mailbox.
    The teardown releases it.
    """
    from types import SimpleNamespace

    # ── allocate ─────────────────────────────────────────────────────────────
    first = await published_agent.provision_inbox(actor=None)
    address = first["inbox"]["address"]

    assert address and "@" in address, f"no address came back: {first}"
    assert first["already_allocated"] is False, "the fixture's agent already had a mailbox"

    # ── ask again: adopt, never allocate twice ───────────────────────────────
    # THE assertion that makes a retry safe. The UI provisions and *then* creates
    # a DataSource in a separate step, so a retry after a half-finished create
    # must not bill for a second address.
    second = await published_agent.provision_inbox(actor=None)
    assert second["already_allocated"] is True
    assert second["inbox"]["address"] == address, (
        "a second address was allocated — a billable leak, and it means retrying "
        "a failed create doubles the cost"
    )

    # ── read it back through the seam everything else uses ───────────────────
    seen = await get_email_inbox_driver().get_inbox(published_agent.id)
    assert seen is not None, "the mailbox we just allocated is not there"
    assert seen["address"] == address
    assert seen["status"] == "active"

    # ── and the ingest driver polls it ───────────────────────────────────────
    # The join between the two halves: allocation (this phase) and the ingest
    # driver (phase 1) against one real inbox. A fresh mailbox is empty, and
    # empty must read as `unchanged`, not as an error.
    source = SimpleNamespace(
        id=f"ds-{uuid.uuid4().hex[:8]}",
        name="agent mail",
        config={"agent_id": published_agent.id, "address": address},
    )
    cursor = SimpleNamespace(
        segment_key=published_agent.id, state={}, window_start=None, first_run=True
    )

    result = await CloudEmailDriver().fetch(source, cursor)

    assert result.items == []
    assert result.unchanged is True
