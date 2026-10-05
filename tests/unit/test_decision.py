"""Decisions through the hub ``APIEndpoint`` marked ``decision``: spec, dialect, discovery, decide.

The hub is doubled at its two seams (``hub_get`` for discovery, ``hub_invoke_raw`` for the
call). The Jev bodies are recorded from the live API (``jev-1.13.0``), not invented.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.external_apis.decision import DecisionError, jev
from flow_sdk.schema.data_spec.decision_spec import (
    ChoiceAnswer,
    DecisionResult,
    DecisionSpec,
    ScoreAnswer,
    YesNoAnswer,
)

JEV_HOST = "https://api.typesafe.ai"
DECIDER = {
    "id": "72575461-9352-4cdb-b2e7-a53be3e3d6e3",
    "name": "Jev",
    "kinds": ["decision"],
    "target": {"base_url": JEV_HOST},
}
OTHER = {
    "id": "11111111-2222-4333-8444-555555555555",
    "name": "Stripe",
    "kinds": [],
    "target": {"base_url": "https://api.stripe.com"},
}

SPEC = DecisionSpec(
    state={"utterance": "open data sources", "page": "/dock/home"},
    questions={
        "target": {
            "type": "choice",
            "instructions": "Which screen?",
            "options": {"view:data-sources": "Data sources", "agentic": "anything else"},
        },
        "quick": {"type": "yes_no", "instructions": "Only an open?"},
        "conf": {"type": "score", "instructions": "How explicit?", "levels": ["vague", "clear", "exact"]},
    },
)
#: Recorded from api.typesafe.ai v1/systemone, jev-1.13.0.
JEV_BODY = {
    "model": "jev-1.13.0",
    "answers": {
        "quick": {"type": "noul", "noul": 0.35},
        "target": {
            "type": "choice",
            "choice": "view:data-sources",
            "confidence": 0.99,
            "probabilities": {"view:data-sources": 0.99, "agentic": 0.01},
        },
        "conf": {
            "type": "score",
            "score": 0.4,
            "confidence": 0.39,
            "legend": {"0": "vague", "1": "clear", "2": "exact"},
            "probabilities": {"0": 0.62, "1": 0.37, "2": 0.01},
        },
    },
    "usage": {"input_tokens": 432, "output_tokens": 81},
}


# ── the spec ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "questions",
    [
        {},
        {f"q{i}": {"type": "yes_no", "instructions": "?"} for i in range(7)},
        {"Target": {"type": "yes_no", "instructions": "?"}},
        {"t": {"type": "choice", "instructions": "?", "options": {"only": "one"}}},
        {"t": {"type": "score", "instructions": "?", "levels": ["one"]}},
        {"t": {"type": "choice", "instructions": "?", "criteria": {"a": "A", "b": "B"}}},  # Jev's word is not ours
        {"t": {"type": "noul", "instructions": "?"}},
    ],
)
def test_a_malformed_spec_is_refused_before_any_call(questions) -> None:
    with pytest.raises(ValueError):
        DecisionSpec(state="x", questions=questions)


def test_pick_answers_only_when_sure() -> None:
    r = DecisionResult(answers={"t": ChoiceAnswer(choice="a", confidence=0.84), "y": YesNoAnswer(probability=0.9)})
    assert r.pick("t") == "a"
    assert r.pick("t", min=0.85) is None
    assert r.pick("y") is None and r.pick("missing") is None


# ── the Jev dialect ─────────────────────────────────────────────────────────


def test_jev_wire_speaks_jevs_words_and_only_there() -> None:
    wire = jev.to_wire(SPEC)
    assert wire["model"] == "jev-latest" and wire["state"] == SPEC.state
    assert wire["questions"]["target"] == {
        "type": "choice",
        "instructions": "Which screen?",
        "criteria": {"view:data-sources": "Data sources", "agentic": "anything else"},
    }
    assert wire["questions"]["quick"] == {"type": "noul", "instructions": "Only an open?"}
    assert wire["questions"]["conf"]["criteria"] == ["vague", "clear", "exact"]


def test_jev_answers_come_back_in_our_words() -> None:
    r = jev.from_wire(SPEC, JEV_BODY)
    assert r.answers["target"] == ChoiceAnswer(
        choice="view:data-sources", confidence=0.99, probabilities={"view:data-sources": 0.99, "agentic": 0.01}
    )
    assert r.answers["quick"] == YesNoAnswer(probability=0.35)
    score = r.answers["conf"]
    assert isinstance(score, ScoreAnswer) and score.probabilities == {"vague": 0.62, "clear": 0.37, "exact": 0.01}
    assert r.model == "jev-1.13.0" and r.usage.input_tokens == 432


def test_a_missing_answer_is_a_bad_response_not_a_silent_gap() -> None:
    with pytest.raises(DecisionError) as e:
        jev.from_wire(SPEC, {"answers": {"target": JEV_BODY["answers"]["target"]}})
    assert e.value.reason == "bad_response"


# ── discovery + decide, hub doubled ─────────────────────────────────────────


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "decisiontest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.instance_settings.api_endpoint import _list_cache

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    reset_instance_settings()
    _list_cache.clear()
    yield
    _list_cache.clear()
    reset_instance_settings()


def _login() -> None:
    from flow_sdk.cli.app_config import set_user
    from flow_sdk.cli.auth.hub_login import set_api_key

    set_api_key("fp-hub-key")
    set_user({"id": "99999999-2222-4333-8444-555555555555", "email": "box@local.test"})


def _hub(monkeypatch, *, listing, catalog, invoke=None):
    import flow_sdk.cloud_client.transport.hub_http as hub_http

    asked: list = []

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        asked.append((entity_type, action))
        return listing if action is None else catalog

    async def _invoke(entity_type, entity_id, sub_path, payload, **kwargs):
        asked.append(("invoke", entity_id, sub_path, payload))
        return invoke

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    monkeypatch.setattr(hub_http, "hub_invoke_raw", _invoke)
    return asked


async def test_a_decision_api_shared_with_everyone_is_found_in_the_catalog_by_its_kind(env, monkeypatch) -> None:
    """The shared Jev endpoint carries no role edge -- only the catalog has it -- and is found by
    ``kinds``, not by id. The listing's envelope and the catalog's bare list are both real shapes."""
    from flow_sdk.instance_settings.api_endpoint import decision_endpoints, fetch_hub_api_endpoints

    _login()
    asked = _hub(monkeypatch, listing={"data": [OTHER]}, catalog=[DECIDER, OTHER])
    assert [o.name for o in await fetch_hub_api_endpoints()] == ["Stripe", "Jev"]
    found = await decision_endpoints()
    assert [(o.id, o.host) for o in found] == [(DECIDER["id"], "api.typesafe.ai")]
    assert asked == [("api_endpoint", None), ("api_endpoint", "catalog")], "memo: the second read asked nothing"


async def test_signed_out_asks_nothing_and_finds_nothing(env, monkeypatch) -> None:
    from flow_sdk.instance_settings.api_endpoint import decision_endpoints

    asked = _hub(monkeypatch, listing={"data": [DECIDER]}, catalog=[DECIDER])
    assert await decision_endpoints() == [] and asked == []


async def test_signing_out_drops_the_listing_taken_while_signed_in(env, monkeypatch) -> None:
    """A listing is what THIS login may call. After sign-out it is nothing -- not the last listing
    from before it, which used to keep the navigator's rules acting as if a decision API were on
    offer until the backend restarted."""
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials
    from flow_sdk.instance_settings.api_endpoint import decision_endpoints

    _login()
    _hub(monkeypatch, listing={"data": []}, catalog=[DECIDER])
    assert [o.id for o in await decision_endpoints()] == [DECIDER["id"]]
    await clear_cloud_credentials()
    assert await decision_endpoints() == []
    assert await decision_endpoints(cached_only=True) == []


async def test_decide_goes_through_the_endpoint_marked_decision(env, monkeypatch) -> None:
    from flow_sdk.decision import decide

    _login()
    asked = _hub(monkeypatch, listing={"data": [OTHER]}, catalog=[DECIDER], invoke=(200, JEV_BODY))
    result = await decide(SPEC)
    invoked = [a for a in asked if a[0] == "invoke"]
    assert invoked and invoked[0][1:3] == (DECIDER["id"], "v1/systemone")
    assert invoked[0][3]["questions"]["quick"]["type"] == "noul", "the body is the dialect's, not ours"
    assert result.pick("target", min=0.85) == "view:data-sources"
    assert result.endpoint == f"api_endpoint-{DECIDER['id']}" and result.latency_ms >= 0


@pytest.mark.parametrize(
    ("listing", "invoke", "reason"),
    [
        ([OTHER], None, "no_endpoint"),  # nothing marked decision
        ([{**DECIDER, "enabled": False}], None, "no_endpoint"),
        ([{**DECIDER, "target": {"base_url": "https://decide.example"}}], None, "no_endpoint"),  # no dialect
        ([DECIDER], (429, {"error": "rate_limited", "message": "slow down"}), "rate_limited"),
        ([DECIDER], (503, {"error": "disabled", "message": "no credential"}), "no_endpoint"),
        ([DECIDER], (502, {"error": "upstream", "message": "unreachable"}), "unavailable"),
        ([DECIDER], (403, {"error": "forbidden", "message": "no role"}), "auth"),
    ],
)
async def test_every_failure_is_one_closed_reason(env, monkeypatch, listing, invoke, reason) -> None:
    from flow_sdk.decision import decide

    _login()
    _hub(monkeypatch, listing={"data": listing}, catalog=[], invoke=invoke)
    with pytest.raises(DecisionError) as e:
        await decide(SPEC)
    assert e.value.reason == reason, e.value.message


async def test_an_invalid_dict_spec_is_refused_as_invalid_spec(env) -> None:
    from flow_sdk.decision import decide

    with pytest.raises(DecisionError) as e:
        await decide({"state": "x", "questions": {"t": {"type": "noul", "instructions": "?"}}})
    assert e.value.reason == "invalid_spec"


# ── availability on the LLM sources screen (funding.status.decision) ────────


async def test_the_llm_sources_status_names_the_decision_api(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import _decision_api

    _login()
    _hub(monkeypatch, listing={"data": []}, catalog=[DECIDER])
    spec = await _decision_api(refresh=True)
    assert spec.available and spec.endpoint == f"api_endpoint-{DECIDER['id']}"
    assert (spec.name, spec.host, spec.reason) == ("Jev", "api.typesafe.ai", "")


async def test_the_llm_sources_status_says_why_there_is_no_decision_api(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import _decision_api

    _hub(monkeypatch, listing={"data": [DECIDER]}, catalog=[])
    signed_out = await _decision_api(refresh=True)
    assert not signed_out.available and "Sign in" in signed_out.reason

    _login()
    _hub(monkeypatch, listing={"data": [OTHER]}, catalog=[])
    none_marked = await _decision_api(refresh=True)
    assert not none_marked.available and "marked as a decision API" in none_marked.reason
