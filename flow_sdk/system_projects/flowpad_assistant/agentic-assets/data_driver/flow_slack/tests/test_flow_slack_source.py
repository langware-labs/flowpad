"""The ``flow_slack`` data source: one person's DM with the Flow Slack app, entirely through the hub.

Offline: the source is handed ``FakeFlowHub``. What is pinned here is Slack's own — the event_callback envelope
both ways and the ``<channel>:<ts>`` ids the hub keys on; Connect and the gate are ``FlowChannel``'s.
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
    return FakeFlowHub(display="the Flow app", deep_link=INSTALL, **kw)


def _source(hub, **config) -> FlowSlackSource:
    return FlowSlackSource(SourceBinding(source_id="ds-sl", config=config), hub=hub)


def _dm(text: str, *, user: str = ME, ts: str = "1700000000.000100", out: bool = False, reply_to: str = "") -> dict:
    event = {"type": "message", "channel_type": "im", "channel": "D1", "user": user, "text": text, "ts": ts}
    if out:
        event.update(bot_id="flow", flowpad_reply_to=reply_to)
    return {"team_id": "T0TEAM", "event": event, **({"flowpad_direction": "out"} if out else {})}


async def test_connect_asks_the_hub_about_slack_and_shows_the_install_link():
    hub = _Hub()
    answer = await _source(hub)._connect(check=False, values={})
    assert answer.ok and answer.value.shown.link.startswith(INSTALL) and set(hub.channels) == {"slack"}


async def test_the_gate_keeps_the_slack_account():
    hub = _Hub()
    await hub.connect("slack", {})
    hub.connected("L1", ME)
    done = await _source(hub, link_id="L1")._connected(check=False, values={})
    assert done.ok and done.value.config == {"sender": ME}


async def test_a_dm_and_flows_answer_become_items_keyed_as_the_hub_keys_them():
    async with _source(_Hub(), sender=ME) as source:
        (asked,) = [e.item for e in source.events_from_webhook(_dm("hi"))]
        (answered,) = [
            e.item
            for e in source.events_from_webhook(_dm("hello", ts="1700000001.000200", out=True, reply_to="1700000000.000100"))
        ]
        other = source.events_from_webhook(_dm("x", user="U0OTHER"))
    assert asked.origin.key == "D1:1700000000.000100" and asked.data.conversation.key == ME
    assert answered.data.sender.name == "Flow" and answered.data.in_reply_to.key == "D1:1700000000.000100"
    assert other == []


async def test_an_answer_goes_to_the_persons_dm():
    hub = _Hub()
    async with _source(hub, sender=ME) as source:
        sent = await source.send(MessageData(text="On it.", conversation=source.conversation_origin(ME)))
    assert hub.sent == [(ME, "On it.", "")] and sent.data.conversation.key == ME
