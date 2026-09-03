"""The email-inbox driver family, and the agent verb on top of it.

Offline: the hub transport is monkeypatched, so nothing here allocates an
address. The live round trip lives in ``tests/hub_tests/`` because provisioning
costs real money.

What these pin is the family's contract rather than the hub's: that "the hub" has
one spelling across families, that a missing mailbox is `False` rather than an
exception while a hub outage still raises, and that asking twice for an agent's
mailbox never allocates twice.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.drivers.hub_email_inbox_driver import HubEmailInboxDriver
from flow_sdk.builtin.email_inbox import EmailInbox
from flow_sdk.builtin.email_inbox_driver import (
    EMAIL_INBOX_DRIVERS,
    EmailInboxDriver,
    EmailInboxError,
    EmailInboxErrorCode,
    get_email_inbox_driver,
)
from flow_sdk.cloud_client.shared.errors import HubError, HubErrorCode

AGENT_ID = "22222222-2222-4222-8222-222222222222"
DESCRIPTOR = {
    "typeid": "agent_mailbox-33333333-3333-4333-8333-333333333333",
    "address": "agent-7@agentmail.to",
    "provider": "agentmail",
    "provider_inbox_id": "agent-7@agentmail.to",
    "status": "active",
    "agent_typeid": f"agent-{AGENT_ID}",
}


class TestTheFamily:
    def test_the_hub_member_is_registered(self):
        assert "flowpad-hub" in EMAIL_INBOX_DRIVERS.kinds()

    def test_hub_has_one_spelling_across_families(self):
        """`flowpad-hub` is also `HubSecretDriver.kind`. Two families disagreeing
        about what "the hub" is called is how an alias table starts drifting."""
        from flow_sdk.builtin.drivers.hub_secret_driver import HubSecretDriver

        assert HubEmailInboxDriver.kind == HubSecretDriver.kind == "flowpad-hub"

    def test_the_bare_alias_resolves(self):
        assert EMAIL_INBOX_DRIVERS.normalize("hub") == "flowpad-hub"
        assert get_email_inbox_driver("hub").kind == "flowpad-hub"

    def test_an_unknown_kind_names_itself(self):
        with pytest.raises(KeyError, match="nonesuch"):
            get_email_inbox_driver("nonesuch")

    def test_the_hub_driver_satisfies_the_protocol(self):
        """`runtime_checkable` only compares method NAMES, so this catches a
        rename, not a signature change — which is exactly the drift it is for."""
        assert isinstance(HubEmailInboxDriver(), EmailInboxDriver)


class TestTheHubMember:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_enable_and_disable_use_the_lifecycle_subpaths(self, monkeypatch):
        seen: list[tuple[str, dict]] = []

        async def fake_post(_type, body, _entity_id, _action, sub_path):
            seen.append((sub_path, body))
            return DESCRIPTOR

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_post)
        driver = HubEmailInboxDriver()

        await driver.enable_inbox(AGENT_ID)
        await driver.disable_inbox(AGENT_ID)

        assert seen == [("enable", {}), ("disable", {})]

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_get_inbox_unwraps_the_envelope(self, monkeypatch):
        """The hub wraps this one (`{"inbox": …|null}`) because a bare null does
        not survive its envelope. Callers should see a descriptor or nothing."""

        async def fake_get(*_a, **_k):
            return {"inbox": DESCRIPTOR}

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

        assert (await HubEmailInboxDriver().get_inbox(AGENT_ID))["address"] == DESCRIPTOR["address"]

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_no_mailbox_reads_as_nothing_not_as_an_empty_dict(self, monkeypatch):
        async def fake_get(*_a, **_k):
            return {"inbox": None}

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

        assert await HubEmailInboxDriver().get_inbox(AGENT_ID) is None

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_deleting_a_mailbox_that_is_gone_is_false_not_an_error(self, monkeypatch):
        """Teardown should not care whether it is the first or second attempt —
        the backend answers 404 for an agent with no active inbox."""

        async def fake_delete(*_a, **_k):
            raise HubError(404, "agent has no inbox")

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_delete", fake_delete)

        assert await HubEmailInboxDriver().delete_inbox(AGENT_ID) is False

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_hub_outage_does_not_read_as_already_gone(self, monkeypatch):
        """The one failure that must NOT be swallowed: 'unreachable' and
        'already deleted' mean opposite things to a caller cleaning up."""

        async def fake_delete(*_a, **_k):
            raise HubError(0, "connection reset")

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_delete", fake_delete)

        # Re-raised as the FAMILY's error, not the hub's: callers above the
        # driver are supposed to work against any backend.
        with pytest.raises(EmailInboxError):
            await HubEmailInboxDriver().delete_inbox(AGENT_ID)

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_hub_machine_error_code_survives_translation(self, monkeypatch):
        async def fake_get(*_a, **_k):
            raise HubError(401, "target unavailable", code=HubErrorCode.TARGET_NOT_FOUND.value)

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

        with pytest.raises(EmailInboxError) as caught:
            await HubEmailInboxDriver().get_inbox(AGENT_ID)

        assert caught.value.code == EmailInboxErrorCode.TARGET_NOT_FOUND

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_old_hub_target_denial_is_classified_with_valid_login(self, monkeypatch):
        async def fake_get(*_a, **_k):
            raise HubError(401, "legacy target denial")

        async def valid_user(_client):
            return {"id": "user-1"}

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)
        monkeypatch.setattr("flow_sdk.cloud_client.client.FlowpadClient.get_user", valid_user)

        with pytest.raises(EmailInboxError) as caught:
            await HubEmailInboxDriver().get_inbox(AGENT_ID)

        assert caught.value.code == EmailInboxErrorCode.TARGET_NOT_FOUND

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_message_id_is_encoded_into_the_path(self, monkeypatch):
        """Message-IDs carry angle brackets and ride in the URL path; the URL
        builder does no quoting."""
        seen = {}

        async def fake_get(_type, entity_id=None, action=None, sub_path=None, **_k):
            seen.update({"action": action, "sub_path": sub_path})
            return {}

        monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", fake_get)

        await HubEmailInboxDriver().get_message(AGENT_ID, "<abc@mail.example>")

        assert seen["action"] == "email_inbox"
        assert seen["sub_path"] == "messages/%3Cabc%40mail.example%3E"


class TestTheAgentVerb:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_an_agent_with_a_mailbox_adopts_it_rather_than_allocating(self, monkeypatch):
        """THE assertion that makes a retry safe. An address is billable and
        permanent, and a caller retries — so asking twice must never bill twice.

        ``newly_allocated`` is what carries that fact now: it is a property of
        the CALL, not of the mailbox, which is why it rides on the projection as
        a runtime-only field rather than being persisted anywhere."""
        from flow_sdk.builtin.agent import Agent

        allocated = _patch_mailbox(monkeypatch, existing=DESCRIPTOR)

        inbox = await Agent(id=AGENT_ID, name="mailer", remote=True).allocate_inbox()

        assert inbox.newly_allocated is False
        assert inbox.address == DESCRIPTOR["address"]
        assert allocated == [], "a second address was allocated for an agent that had one"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_an_agent_without_one_gets_a_mailbox(self, monkeypatch):
        from flow_sdk.builtin.agent import Agent

        _patch_mailbox(monkeypatch, existing=None)

        inbox = await Agent(id=AGENT_ID, name="mailer", remote=True).allocate_inbox()

        assert inbox.newly_allocated is True
        assert inbox.address == DESCRIPTOR["address"]

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_allocating_without_a_cloud_login_refuses_before_reaching_the_hub(
        self, monkeypatch
    ):
        """The address costs money, so a logged-out caller must be stopped here
        rather than discovering it as a 401 halfway through allocation."""
        from flow_sdk.auth import LoginRequired
        from flow_sdk.builtin.agent import Agent

        allocated = _patch_mailbox(monkeypatch, existing=None, logged_in=False)

        with pytest.raises(LoginRequired):
            await Agent(id=AGENT_ID, name="mailer", remote=True).allocate_inbox()
        assert allocated == []

    def test_the_action_is_routable_and_declares_no_parameters(self):
        """`agent.py` carries `from __future__ import annotations`, and the
        dispatcher resolves an annotated `request` by IDENTITY — so an annotated
        parameter 400s over HTTP while every direct-call test still passes."""
        import inspect

        from flow_sdk.actions.action_registry import action as registry
        from flow_sdk.builtin.agent import Agent

        assert "agent.allocate_inbox" in registry.function_registry

        params = set(inspect.signature(Agent.allocate_inbox_action).parameters) - {"self", "cls"}
        assert not params, f"allocate_inbox_action declares {sorted(params)}"


def _patch_mailbox(monkeypatch, *, existing, logged_in=True):
    """Swap in a mailbox backend. Returns the list of agents it allocated for.

    Also stubs the two things allocation touches beyond the backend: the cloud
    login gate, and the local source it wires. Neither is what these tests are
    about — they pin the adopt-vs-allocate decision, and keeping them free of a
    database is what keeps that decision cheap to assert."""
    allocated: list[str] = []

    class _Driver:
        kind = "flowpad-hub"

        async def get_inbox(self, agent_id):
            return existing

        async def enable_inbox(self, agent_id, **_options):
            if not existing:
                allocated.append(agent_id)
            return DESCRIPTOR

    monkeypatch.setattr(
        "flow_sdk.builtin.email_inbox_driver.get_email_inbox_driver", lambda *_a, **_k: _Driver()
    )
    monkeypatch.setattr(
        "flow_sdk.cli.auth.hub_login.hub_auth_available", lambda *_a, **_k: logged_in
    )

    async def _no_source(self):
        return None

    monkeypatch.setattr(EmailInbox, "ensure_source", _no_source)
    return allocated
