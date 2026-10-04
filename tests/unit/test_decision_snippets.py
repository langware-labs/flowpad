"""``docs/snippets/decisions.md``: every Python fence, run as written.

The hub is doubled at its two seams -- ``hub_get`` (the endpoint listing + catalog) and
``hub_invoke_raw`` (the call) -- and the double answers in Jev's real wire shape, so the
dialect's translation runs for real. The live leg is ``tests/long_tests/test_decision_live.py``.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from tests.utils.harness_installed import harness_installed  # noqa: F401 -- a fixture
from tests.utils.snippets import SHELF, fence_under, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DOC = (SHELF / "decisions.md").read_text(encoding="utf-8")
DECIDER = {
    "id": "72575461-9352-4cdb-b2e7-a53be3e3d6e3",
    "name": "Jev (TypeSafe)",
    "kinds": ["decision"],
    "target": {"base_url": "https://api.typesafe.ai"},
}


def _jev_answers(wire: dict) -> dict:
    """What Jev answers, in its own shape: the first option, a mid score, a likely yes."""
    answers = {}
    for name, q in wire["questions"].items():
        if q["type"] == "choice":
            first = next(iter(q["criteria"]))
            answers[name] = {
                "type": "choice",
                "choice": first,
                "confidence": 0.97,
                "probabilities": {k: (0.97 if k == first else 0.03 / (len(q["criteria"]) - 1)) for k in q["criteria"]},
            }
        elif q["type"] == "score":
            answers[name] = {
                "type": "score",
                "score": 1.0,
                "confidence": 0.7,
                "legend": {str(i): lvl for i, lvl in enumerate(q["criteria"])},
                "probabilities": {str(i): (0.7 if i == 1 else 0.1) for i in range(len(q["criteria"]))},
            }
        else:
            answers[name] = {"type": "noul", "noul": 0.9}
    return {"model": "jev-1.13.0", "answers": answers, "usage": {"input_tokens": 300, "output_tokens": 0}}


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "decisionsnippets")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.cli.app_config import set_user
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.instance_settings.api_endpoint import _list_cache

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    reset_instance_settings()
    _list_cache.clear()
    set_api_key("fp-hub-key")
    set_user({"id": "99999999-2222-4333-8444-555555555555", "email": "box@local.test"})
    state = {"status": 200, "invoked": []}

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        if entity_type != "api_endpoint":
            return {"data": []}
        return [DECIDER] if action == "catalog" else {"data": []}

    async def _invoke(entity_type, entity_id, sub_path, payload, **kwargs):
        state["invoked"].append((entity_id, sub_path))
        if state["status"] != 200:
            return state["status"], {"error": "rate_limited", "message": "slow down"}
        return 200, _jev_answers(payload)

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    monkeypatch.setattr(hub_http, "hub_invoke_raw", _invoke)
    yield state
    _list_cache.clear()
    reset_instance_settings()


async def test_one_decision(hub):
    ns = await run_fence(fence_under(DOC, "1."))
    assert ns["result"].pick("target", min=0.85) == "view:data-sources"
    assert ns["result"].endpoint == f"api_endpoint-{DECIDER['id']}"
    assert hub["invoked"] == [(DECIDER["id"], "v1/systemone")]


async def test_which_endpoint_answers(hub):
    ns = await run_fence(fence_under(DOC, "2."))
    assert [(o.name, o.host) for o in ns["deciders"]] == [("Jev (TypeSafe)", "api.typesafe.ai")]


async def test_three_kinds_then_act_only_when_sure(hub):
    ns = await run_fence(fence_under(DOC, "3."))
    assert ns["route"] == "billing" and ns["urgency"] == 1.0 and ns["escalate"] == 0.9
    assert ns["result"].answers["urgency"].probabilities["today"] == 0.7, "keyed by the level's text"
    ns = await run_fence(fence_under(DOC, "4."), ns)
    assert ns["key"] == "billing"


async def test_when_it_cannot_answer(hub):
    ns = await run_fence(fence_under(DOC, "1."))
    hub["status"] = 429
    ns = await run_fence(fence_under(DOC, "5."), ns)
    assert ns["reason"] == "rate_limited"


async def test_the_magic_line_route(hub):
    ns = await run_fence(fence_under(DOC, "7."))
    assert ns["answer"].route == "quick" and ns["answer"].target.value == "data-sources"
    assert hub["invoked"] == [], "an exact screen name is a rule: no decision is spent"


@pytest.mark.usefixtures("harness_installed")
async def test_availability_on_the_funding_status(hub):
    ns = await run_fence(fence_under(DOC, "8."))
    assert ns["decision"].available and ns["decision"].name == "Jev (TypeSafe)"
