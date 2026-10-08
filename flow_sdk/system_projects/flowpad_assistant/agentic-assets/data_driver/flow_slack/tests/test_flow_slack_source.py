"""The ``flow_slack`` data source: one person's DM with Flowpad's Slack app, through the hub's chain.

Offline: the source is handed ``FakeFlowHub``. What is pinned here is Slack's own — the event_callback envelope, the
``<channel>:<ts>`` ids the hub keys on, and a claim proven under a workspace-scoped key; Connect and the gate are
``FlowChannel``'s.
"""

from __future__ import annotations

import pytest

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.testing.flow_hub import FakeFlowHub
from flow_sdk.sources.values.items import MessageData

module = asset_module("flow_slack")
FlowSlackSource = module.FlowSlackSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ME = "U0DANA"
INSTALL = "https://slack.com/oauth/v2/authorize"


def _Hub(**kw) -> FakeFlowHub:
    return FakeFlowHub(deep_link=INSTALL, **kw)


def _source(hub, **config) -> FlowSlackSource:
    return FlowSlackSource(SourceBinding(source_id="ds-sl", config=config), hub=hub)


def _dm(text: str, *, user: str = ME, ts: str = "1700000000.000100") -> dict:
    event = {"type": "message", "channel_type": "im", "channel": "D1", "user": user, "text": text, "ts": ts}
    return {"team_id": "T0TEAM", "event": event}


async def test_connect_claims_slack_and_shows_the_install_link():
    hub = _Hub()
    answer = await _source(hub)._connect(check=False, values={})
    assert answer.ok and answer.value.shown.link.startswith(INSTALL) and hub.channels == ["slack"]


async def test_the_gate_keeps_the_slack_account_out_of_its_workspace_scoped_key():
    """A Slack user id is unique only inside its workspace, so the hub proves ``<team>:<user>``; the account kept
    here is the user."""
    hub = _Hub()
    await hub.connect("slack", {})
    hub.connected("C1", f"T0TEAM:{ME}")
    done = await _source(hub, claim_id="C1")._connected(check=False, values={})
    assert done.ok and done.value.config == {"sender": ME}


async def test_a_dm_becomes_an_item_keyed_as_the_hub_keys_it():
    async with _source(_Hub(), sender=ME) as source:
        (asked,) = [e.item for e in source.events_from_webhook(_dm("hi"))]
        other = source.events_from_webhook(_dm("x", user="U0OTHER"))
    assert asked.origin.key == "D1:1700000000.000100" and asked.data.conversation.key == ME
    assert other == []


async def test_a_send_goes_to_the_persons_dm_through_the_claim():
    hub = _Hub()
    async with _source(hub, claim_id="C1", sender=ME) as source:
        sent = await source.send(MessageData(text="On it.", conversation=source.conversation_origin(ME)))
    assert hub.replies == [("C1", "On it.", "")] and sent.data.conversation.key == ME
