"""``decision`` on ``compute_node/@local``: the desk's way to the hub's decision API.

The hub is doubled at ``flow_sdk.decision``'s two seams; what is under test is the box
contract -- the envelope, the ``DecisionResult`` shape, and a failure that carries its
closed reason so the UI can fall back without reading a sentence.
"""

from __future__ import annotations

import pytest

from flow_sdk.external_apis.decision import DecisionError
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult

PATH = "/api/v1/graph/compute_node/@local/decision"
NAV = "/api/v1/graph/compute_node/@local/navigator-route"
SPEC = {
    "state": {"utterance": "open data sources"},
    "questions": {"target": {"type": "choice", "instructions": "?", "options": {"a": "A", "agentic": "else"}}},
}
OFFER = APIEndpointOffer(
    id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
)


@pytest.fixture
def hub(monkeypatch):
    import flow_sdk.decision as decision

    calls: list = []
    state = {"error": None}

    async def _decide(spec, *, endpoint=None):
        calls.append((spec, endpoint))
        if state["error"]:
            raise state["error"]
        return DecisionResult(
            answers={"target": ChoiceAnswer(choice="a", confidence=0.97)}, model="jev-1.13.0", endpoint=OFFER.typeid
        )

    async def _endpoints(**kwargs):
        return [OFFER]

    monkeypatch.setattr(decision, "decide", _decide)
    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    return calls, state


@pytest.mark.asyncio
async def test_get_lists_the_decision_apis(bootstrapped_client, hub):
    body = (await bootstrapped_client.get(f"{PATH}/endpoints")).json()
    assert body["status"] == "SUCCESS"
    assert body["data"] == [
        {"id": OFFER.id, "name": "Jev", "kinds": ["decision"], "enabled": True, "host": "api.typesafe.ai"}
    ]


@pytest.mark.asyncio
async def test_post_takes_one_decision(bootstrapped_client, hub):
    calls, _ = hub
    body = (await bootstrapped_client.post(PATH, json={"spec": SPEC})).json()
    assert body["status"] == "SUCCESS", body
    assert body["data"]["answers"]["target"] == {
        "type": "choice",
        "choice": "a",
        "confidence": 0.97,
        "probabilities": {},
    }
    assert body["data"]["endpoint"] == OFFER.typeid
    assert calls == [(SPEC, None)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reason", "status"), [("no_endpoint", 404), ("rate_limited", 429), ("unavailable", 503), ("auth", 403)]
)
async def test_a_failure_carries_its_closed_reason(bootstrapped_client, hub, reason, status):
    """Never 401 (the desk client alerts) and never 502 (it retries, reading a waking sandbox)."""
    _, state = hub
    state["error"] = DecisionError(reason, "a sentence for a person")
    r = await bootstrapped_client.post(PATH, json={"spec": SPEC})
    body = r.json()
    assert body["status"] == "FAIL"
    assert body["data"] == {"reason": reason}
    assert (body.get("status_code") or r.status_code) == status


@pytest.mark.asyncio
async def test_navigator_route_reads_where_the_active_tab_is(bootstrapped_client, monkeypatch):
    """The magic line sends only what was typed; the route reads the tab's own browser context as
    ``navigation.here`` -- its address, and the entity open there."""
    import flow_sdk.decision as decision
    from flow_sdk.server.routes import websocket

    specs: list = []

    async def _decide(spec, *, endpoint=None):
        specs.append(spec)
        return DecisionResult(answers={"target": ChoiceAnswer(choice="agentic", confidence=0.99)})

    async def _endpoints(**kwargs):
        return [OFFER]

    monkeypatch.setattr(decision, "decide", _decide)
    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    asset = "markdown-0d5e6f7a-8b9c-4d4e-8f5a-6b7c8d9e0f1a"
    url = f"/dock/assets/{asset}?viewMode=edit"
    monkeypatch.setattr(
        websocket,
        "_active_connections",
        {
            "tab-1": websocket.ConnectionInfo(
                ws=object(), is_tab=True, browser_context={"CurrentUrl": url, "CurrentActiveEntityTypeId": asset}
            )
        },
    )
    body = (await bootstrapped_client.post(f"{NAV}", json={"utterance": "summarize this doc"})).json()
    assert body["data"]["route"] == "agentic"
    assert specs[0].state["page"] == url and specs[0].state["context"]["entity"]["typeid"] == asset
    assert f"entity:{asset}" in specs[0].questions["target"].options, "what is open is offered as 'this'"
