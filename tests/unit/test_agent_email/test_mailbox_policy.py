"""The mailbox's policy is the Hub's, and the local copy is only a cache.

Step 2 moved the allowlist onto the Hub's ``EmailInbox`` row. What has to hold
afterwards is narrow but load-bearing: the descriptor is where policy comes
from, a write goes to the Hub and adopts what the Hub stored (not what we sent),
and the local mirror exists solely so the per-message gate needs no network.
"""
from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.email_inbox import EmailInbox

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _descriptor(agent: Agent, **overrides) -> dict:
    base = {
        "typeid": f"agent_mailbox-{mint_uuid()}",
        "agent_typeid": str(agent.typeid),
        "address": "ada@agentmail.to",
        "display_name": "Ada",
        "provider": "agentmail",
        "provider_inbox_id": f"inbox-{mint_uuid()}",
        "status": "active",
    }
    base.update(overrides)
    return base


class _Hub:
    """A mailbox backend that stores policy the way the real Hub does."""

    kind = "flowpad-hub"

    def __init__(self, descriptor: dict):
        self.descriptor = dict(descriptor)
        self.configured: list[dict] = []

    async def configure_inbox(self, agent_id, settings):
        self.configured.append(settings)
        if "allowed_senders" in settings:
            # The Hub normalizes; that is the whole reason the caller adopts the
            # response instead of trusting its own input.
            self.descriptor["allowed_senders"] = [
                str(a).strip().lower() for a in settings["allowed_senders"]
            ]
        if "filters" in settings:
            self.descriptor["filters"] = dict(settings["filters"])
        return dict(self.descriptor)

    async def enable_inbox(self, agent_id, **_options):
        return dict(self.descriptor)

    async def get_inbox(self, agent_id):
        return dict(self.descriptor)


def _patch(monkeypatch, hub: _Hub, *, wire_source: bool = False) -> None:
    monkeypatch.setattr(
        "flow_sdk.builtin.email_inbox_driver.get_email_inbox_driver", lambda *_a, **_k: hub
    )
    monkeypatch.setattr(
        "flow_sdk.cli.auth.hub_login.hub_auth_available", lambda *_a, **_k: True
    )

    if wire_source:
        return

    async def _no_source(self):
        return None

    monkeypatch.setattr(EmailInbox, "ensure_source", _no_source)


async def test_policy_comes_from_the_descriptor():
    """The Hub row owns the allowlist, so the descriptor is where it is read."""
    agent = Agent(name="ada-policy")
    inbox = EmailInbox.from_hub_descriptor(
        _descriptor(agent, allowed_senders=["boss@corp.com"], filters={"labels": "received"}),
        agent_typeid=agent.typeid,
    )

    assert inbox.allowed_senders == ["boss@corp.com"]
    assert inbox.filters == {"labels": "received"}
    assert inbox.allowed("boss@corp.com") is True
    assert inbox.allowed("stranger@corp.com") is False


async def test_a_hub_without_policy_yields_a_closed_mailbox():
    """An older Hub carries no allowlist. That must read as CLOSED, never open."""
    agent = Agent(name="ada-old-hub")
    inbox = EmailInbox.from_hub_descriptor(_descriptor(agent), agent_typeid=agent.typeid)

    assert inbox.allowed_senders == []
    assert inbox.allowed("anyone@corp.com") is False


async def test_configure_writes_the_hub_and_adopts_what_it_stored(mail_db, monkeypatch):
    agent = Agent(name=f"ada-configure-{mint_uuid()[:8]}", remote=True)
    await agent.save()
    hub = _Hub(_descriptor(agent))
    _patch(monkeypatch, hub)

    inbox = await EmailInbox.for_agent(agent)
    await inbox.configure(allowed_senders=["  Boss@Corp.com "], filters={"labels": "received"})

    assert hub.configured == [
        {"allowed_senders": ["  Boss@Corp.com "], "filters": {"labels": "received"}}
    ], "the write must reach the Hub"
    # Adopted from the Hub's response, not from what we sent.
    assert inbox.allowed_senders == ["boss@corp.com"]
    assert inbox.filters == {"labels": "received"}


async def test_the_local_copy_is_a_cache_the_gate_reads_without_a_network_call(
    mail_db, monkeypatch
):
    """The cache is what makes `allowed()` pure, and it lives on the mailbox's own
    local row so it is scoped — and invalidated — with the thing it describes."""
    from flow_sdk.builtin.data_source import DataSource

    agent = Agent(name=f"ada-cache-{mint_uuid()[:8]}", remote=True)
    await agent.save()
    hub = _Hub(_descriptor(agent))
    _patch(monkeypatch, hub, wire_source=True)

    inbox = await EmailInbox.for_agent(agent)
    await inbox.ensure_source()
    await inbox.configure(allowed_senders=["boss@corp.com"])

    source = await DataSource.find_for_account("cloud_email", "agent_id", agent.id)
    assert source.inbound_allowed_senders == ["boss@corp.com"], "the cache follows the Hub"
    # And the gate reads it back with no agent and no network.
    assert EmailInbox.from_source(source).allowed("boss@corp.com") is True


async def test_allocating_with_an_allowlist_declares_it_at_the_hub(mail_db, monkeypatch):
    """`allocate_inbox(allowed_senders=…)` is one call to the caller, and the
    policy still lands on the Hub — the mailbox has to exist before it can carry
    one, so the order is allocate then configure."""
    agent = Agent(name=f"ada-allocate-{mint_uuid()[:8]}", remote=True)
    await agent.save()
    hub = _Hub(_descriptor(agent))
    _patch(monkeypatch, hub)

    inbox = await agent.allocate_inbox(allowed_senders=["boss@corp.com"])

    assert hub.configured == [{"allowed_senders": ["boss@corp.com"]}]
    assert inbox.allowed("boss@corp.com") is True


# --- what "target_not_found" actually meant ---------------------------------


class _HiddenAgentHub:
    """A hub that hides an agent the caller holds no role on.

    `HubErrorCode.TARGET_NOT_FOUND` is deliberately ambiguous — it covers both
    "no such agent" and "not yours" so existence does not leak. This fake is the
    second case, which is the one that used to end in a raw 409.
    """

    kind = "flowpad-hub"

    def __init__(self, *, visible_after_publish: bool):
        self.visible_after_publish = visible_after_publish
        self.probes = 0

    async def get_inbox(self, agent_id):
        from flow_sdk.builtin.email_inbox_driver import EmailInboxError, EmailInboxErrorCode

        self.probes += 1
        if self.probes > 1 and self.visible_after_publish:
            return {
                "typeid": f"agent_mailbox-{mint_uuid()}",
                "agent_typeid": self._agent_typeid,
                "address": "ada@agentmail.to",
                "provider": "agentmail",
                "provider_inbox_id": "inbox-1",
                "status": "active",
            }
        exc = EmailInboxError(401, "Target entity not found")
        exc.code = EmailInboxErrorCode.TARGET_NOT_FOUND
        raise exc

    async def enable_inbox(self, agent_id, **_options):
        return {
            "typeid": f"agent_mailbox-{mint_uuid()}",
            "agent_typeid": self._agent_typeid,
            "address": "ada@agentmail.to",
            "provider": "agentmail",
            "provider_inbox_id": "inbox-1",
            "status": "active",
        }


async def _agent_that_cannot_publish(monkeypatch, hub):
    """A local agent the hub already holds under someone else: `share()` conflicts."""
    agent = Agent(name=f"ada-hidden-{mint_uuid()[:8]}")
    await agent.save()
    hub._agent_typeid = str(agent.typeid)

    async def conflicting_share(self):
        raise ValueError('API returned status 409: {"detail":"A conflicting record already exists"}')

    monkeypatch.setattr(Agent, "share", conflicting_share)
    _patch(monkeypatch, hub, wire_source=True)
    return agent


async def test_an_agent_owned_by_someone_else_says_so(mail_db, monkeypatch):
    """The failure a person can act on, not the database's word for it.

    Publishing is the right answer to "no such agent" and guaranteed to conflict
    on "not yours" — so a 409 out of `share()` must not reach the user as
    "a conflicting record already exists", which describes a constraint rather
    than anything they can do.
    """
    from flow_sdk.builtin.email_inbox_driver import EmailInboxError, EmailInboxErrorCode

    hub = _HiddenAgentHub(visible_after_publish=False)
    agent = await _agent_that_cannot_publish(monkeypatch, hub)

    with pytest.raises(EmailInboxError) as raised:
        await agent.allocate_inbox()

    # The CODE, not the sentence: the sentence is product copy on its way to a
    # toast, so asserting it would go red on a rewording and — worse — a
    # "conflicting record not in message" check passes vacuously the day the hub
    # rewords its own 409.
    assert raised.value.code == EmailInboxErrorCode.FOREIGN_TARGET
    assert raised.value.status_code == 403
    assert agent.remote is False, "a failed adoption must not leave the agent marked published"


async def test_an_agent_published_from_another_instance_is_adopted(mail_db, monkeypatch):
    """The same 409, the other meaning: the row is OURS, published elsewhere.
    Re-probing after the conflict is what tells the two apart."""
    hub = _HiddenAgentHub(visible_after_publish=True)
    agent = await _agent_that_cannot_publish(monkeypatch, hub)

    inbox = await agent.allocate_inbox()

    assert inbox.address == "ada@agentmail.to"
    assert agent.remote is True
    assert hub.probes == 2, "the second probe is what resolved the ambiguity"
