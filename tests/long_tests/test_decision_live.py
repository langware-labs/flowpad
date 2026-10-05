"""Live: a box finds the hub's decision API by its kind and takes a real decision through it.

The whole path, nothing doubled:

1. an operator creates a Jev ``APIEndpoint`` on the hub, tags it ``kinds: ["decision"]``, keys
   it, caps it and opens it to every signed-in user;
2. a box signed in as a DIFFERENT user -- no role on the endpoint, so it is in the catalog
   alone -- calls ``decide(spec)`` with no endpoint id;
3. the answer is Jev's, in our words, through the hub's key.

Needs a running LOCAL hub (``DECISION_LIVE_HUB``, default ``http://localhost:8093``) and
``JEV_API_KEY`` (read from the environment; never printed). Skips without either. One
decision through the hub costs a few hundred input tokens.

    JEV_API_KEY=… uv run pytest tests/long_tests/test_decision_live.py
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: Its own variable, never ``FLOWPAD_HUB_URL``: that one names PRODUCTION in a desktop shell, and
#: this test signs users up and creates an endpoint. A non-local hub is refused, not used.
HUB = os.environ.get("DECISION_LIVE_HUB", "http://localhost:8093").rstrip("/")


def _hub_up() -> bool:
    if not HUB.startswith(("http://localhost:", "http://127.0.0.1:")):
        return False
    try:
        return httpx.get(f"{HUB}/api/v1/graph/bootstrap", timeout=3).status_code == 200
    except httpx.HTTPError:
        return False


def _user_token(c: httpx.Client, who: str) -> tuple[str, dict]:
    email, pw = f"{who}@local.test", f"{who}-pw-1234"
    c.post(f"{HUB}/api/v1/signup", json={"name": who, "email": email, "password": pw})  # idempotent
    r = c.post(f"{HUB}/api/v1/login", json={"email": email, "password": pw})
    r.raise_for_status()
    data = r.json()["data"]
    return data["token"], data["user"]


@pytest.fixture
def decision_endpoint():
    key = os.environ.get("JEV_API_KEY")
    if not key:
        pytest.skip("JEV_API_KEY is not set")
    if not _hub_up():
        pytest.skip(f"no local hub at {HUB}")
    with httpx.Client(timeout=20) as c:
        token, _ = _user_token(c, "decision-operator")
        h = {"Authorization": f"Bearer {token}"}
        made = c.post(
            f"{HUB}/api/v1/graph/api_endpoint",
            headers=h,
            json={
                "name": f"Jev decisions {uuid.uuid4().hex[:6]}",
                "kinds": ["decision"],
                "target": {
                    "base_url": "https://api.typesafe.ai",
                    "inject": {"header": "Authorization", "format": "Bearer {value}"},
                    "probe_path": "v1/models",
                },
            },
        )
        assert made.status_code == 200, made.text
        eid = made.json()["data"]["id"]
        base = f"{HUB}/api/v1/graph/api_endpoint/{eid}"
        try:
            assert c.post(f"{base}/credential", headers=h, json={"key": key}).status_code == 200
            assert (
                c.put(
                    base,
                    headers=h,
                    json={
                        "filters": {"paths_allow": ["v1/**"]},
                        "limits": {"requests_per_minute": 100, "per_caller_requests_per_minute": 20},
                        "meter": {"kind": "json_usage", "input_usd_per_million": 0.042},
                    },
                ).status_code
                == 200
            )
            opened = c.put(f"{base}/access/public/authenticated", headers=h, json={"role": "reader"})
            assert opened.status_code == 200, opened.text
            yield eid
        finally:
            c.delete(base, headers=h)


@pytest.fixture
def box_signed_in_as_someone_else(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "decisionlive")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.cli.app_config import set_user
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.instance_settings.api_endpoint import _list_cache

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", HUB)
    reset_instance_settings()
    _list_cache.clear()
    with httpx.Client(timeout=20) as c:
        token, user = _user_token(c, "decision-caller")
    set_api_key(token)
    set_user(user)
    yield
    _list_cache.clear()
    reset_instance_settings()


async def test_a_box_finds_the_decision_api_by_kind_and_decides(decision_endpoint, box_signed_in_as_someone_else):
    from flow_sdk.decision import DecisionSpec, decide, decision_endpoints

    found = await decision_endpoints()
    assert decision_endpoint in [o.id for o in found], f"not found by kind: {found}"

    spec = DecisionSpec(
        state={"utterance": "open data sources", "page": "/dock/home"},
        questions={
            "target": {
                "type": "choice",
                "instructions": "Which option opens what `utterance` asks for?",
                "options": {
                    "view:data-sources": "Screen 'Data sources' (connectors, integrations)",
                    "view:credentials": "Screen 'Credentials' (api keys, secrets)",
                    "agentic": "Anything that is not a plain open",
                },
            },
            "escalate": {"type": "yes_no", "instructions": "Does `utterance` ask for an explanation?"},
        },
    )
    result = await decide(spec, endpoint=decision_endpoint)
    assert result.pick("target", min=0.85) == "view:data-sources", result
    assert 0.0 <= result.answers["escalate"].probability <= 1.0
    assert result.model.startswith("jev-") and result.usage.input_tokens > 0
    assert result.endpoint == f"api_endpoint-{decision_endpoint}"
