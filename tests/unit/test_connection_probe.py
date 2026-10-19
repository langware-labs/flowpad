"""The hub's round-trip connection probe, on the receiving desktop.

The hub sends a normal channel message from ``probe-<nonce>`` with ``x-flowpad-probe*`` headers.
``route`` answers the hub who would answer and where, ingesting nothing; ``agent`` ingests it and lets
the probe sender past the source's allowlist, so the agent answers it like a person. Only the header on
a hub-verified delivery marks a probe — a message from ``probe-…`` without it is any stranger.
"""
from __future__ import annotations

import base64
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from flow_sdk.builtin import agent_serve
from flow_sdk.builtin.agent_serve import admits
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.server.routes import data_source_webhook

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

SOURCE_ID = "5b0e6c5e-9a43-4c39-9d4b-0c7a3b2f4e11"


def _row(**over):
    row = SimpleNamespace(id=SOURCE_ID, provider="whatsapp", status=SourceStatus.ACTIVE.value, config={},
                          allowed_senders=[], owner="", answer_place=None, channel="whatsapp")
    row.__dict__.update(over)
    return row


@pytest.fixture
def channel(monkeypatch):
    """The route with this row as the only source and an ingest that records what it was handed."""
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.cloud_client.transport import hub_http

    state = SimpleNamespace(row=_row(), ingested=[], hub=[])

    async def ingest_pushed(row, payload, **kw):
        state.ingested.append(payload)
        return {"ingested": 1}

    async def get_by_id(source_id):
        return state.row if source_id == SOURCE_ID else None

    async def pushing(name, verb):
        return SimpleNamespace(ingest_pushed=ingest_pushed)

    async def hub_post(entity_type, payload, entity_id=None, action=None, *a, **kw):
        state.hub.append((entity_type, entity_id, action, payload))
        return {}

    monkeypatch.setattr(DataSource, "get_by_id", get_by_id)
    monkeypatch.setattr(data_source_webhook, "_pushing_type", pushing)
    monkeypatch.setattr(hub_http, "hub_post", hub_post)
    monkeypatch.setattr(agent_serve, "_PROBES", {})
    return state


async def _post(headers):
    app = FastAPI()
    app.include_router(data_source_webhook.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local.test") as client:
        return await client.post(f"/api/v1/data_source/{SOURCE_ID}/webhook", json={"entry": []}, headers=headers)


def _probe(phase, nonce="n1"):
    return {"x-flowpad-probe": nonce, "x-flowpad-probe-phase": phase, "x-flowpad-probe-claim": "claim-7"}


async def test_a_route_probe_tells_the_hub_who_answers_and_ingests_nothing(channel, monkeypatch):
    from flow_sdk.builtin.agent import Agent

    async def agent_by_id(agent_id):
        return SimpleNamespace(name="Concierge") if agent_id == "a1" else None

    monkeypatch.setattr(Agent, "get_by_id", agent_by_id)
    channel.row.owner = "agent-a1"
    response = await _post(_probe("route"))
    assert response.status_code == 200 and channel.ingested == []
    assert channel.hub == [("webhook", "claim-7", "reply", {"event_id": "n1", "text": "Concierge @ This computer"})]


async def test_a_route_probe_names_the_answering_deployment(channel):
    async def places():
        return [{"key": "this", "label": "This computer"}, {"key": "dep-1", "label": "production · e2b"}]

    channel.row.answer_place, channel.row.route_places = "dep-1", places
    await _post(_probe("route"))
    assert channel.hub[0][3]["text"] == "nobody @ production · e2b"


async def test_an_agent_probe_is_ingested_and_admitted_past_an_empty_allowlist(channel):
    assert not admits(channel.row, "probe-n1"), "before the probe arrives, a stranger"
    response = await _post(_probe("agent"))
    assert response.status_code == 200 and len(channel.ingested) == 1 and channel.hub == []
    assert admits(channel.row, "probe-n1")
    assert not admits(channel.row, "probe-other") and not admits(_row(id="another"), "probe-n1")


async def test_a_delivery_without_the_probe_header_admits_nobody_new(channel):
    await _post({})
    assert len(channel.ingested) == 1 and not admits(channel.row, "probe-n1")


async def test_an_admitted_probe_is_answered_and_the_reply_goes_back_to_it(channel, monkeypatch):
    await _post(_probe("agent"))
    replies = []

    async def reply_spec(body, files):
        return SimpleNamespace(body=body)

    async def reply(spec):
        replies.append((message.author_external_id, spec.body))

    async def run(turn, process=None):
        return SimpleNamespace(ok=True, text="pong", detail="")

    message = SimpleNamespace(author_external_id="probe-n1", body="ping", files=(), data=None, reply_to=None,
                              data_source_id=SOURCE_ID, external_id="wamid.P", author_display="",
                              reply_spec=reply_spec, reply=reply)
    engine = SimpleNamespace(agent=SimpleNamespace(name="Concierge", id="a1"), deployment=None, run=run)
    monkeypatch.setattr(agent_serve, "is_own_outgoing", lambda source, author: False)
    assert await agent_serve.answer(engine, message, source=channel.row, session="conversation-x")
    assert replies == [("probe-n1", "pong")]

    stranger = SimpleNamespace(**{**message.__dict__, "author_external_id": "972500000001"})
    assert not await agent_serve.answer(engine, stranger, source=channel.row, session="conversation-x")
    assert len(replies) == 1, "a non-probe sender the allowlist does not name is still refused"


async def test_the_relay_forwards_the_probe_headers(monkeypatch):
    from flow_sdk.cloud_client import webhook_relay

    seen = []

    async def request(self, method, url, headers=None, content=None):
        seen.append(dict(headers))
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    import flow_sdk.instance_settings as settings

    monkeypatch.setattr(settings, "get_instance_settings", lambda: SimpleNamespace(port=1))
    status = await webhook_relay._replay({
        "path": f"/api/v1/data_source/{SOURCE_ID}/webhook", "body_b64": base64.b64encode(b"{}").decode(),
        "headers": [[k, v] for k, v in _probe("agent", "n9").items()],
    })
    assert status == 200 and seen == [_probe("agent", "n9")]


def test_admitted_probe_senders_stay_bounded(monkeypatch):
    """Only the latest probes are let through; the oldest drop past the cap instead of piling up."""
    from flow_sdk.builtin import agent_serve

    monkeypatch.setattr(agent_serve, "_PROBES", {})
    monkeypatch.setattr(agent_serve, "_MAX_PROBES", 3)
    for n in range(5):
        agent_serve.admit_probe("src", f"probe-{n}")
    assert list(agent_serve._PROBES) == [("src", "probe-2"), ("src", "probe-3"), ("src", "probe-4")]


async def test_deleting_a_channel_releases_its_hub_claims(monkeypatch):
    """A deleted channel's hub claim must go too: left behind it kept taking the number's messages."""
    from flow_sdk.builtin import data_source as ds
    from flow_sdk.cloud_client.transport import hub_http

    deleted = []

    async def claims():
        return [{"id": "c-mine", "target": {"data_source_id": "src-1"}}, {"id": "c-other", "target": {"data_source_id": "src-2"}}]

    async def hub_delete(kind, eid, *a, **k):
        deleted.append((kind, eid))

    monkeypatch.setattr(ds, "_hub_claims", claims)
    monkeypatch.setattr(hub_http, "hub_delete", hub_delete)
    source = ds.DataSource(provider="whatsapp", name="x", config={})
    source.id = "src-1"
    assert await source.release_hub_claims() == ""
    assert deleted == [("webhook", "c-mine")]
