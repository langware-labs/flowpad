"""The Decision API, doubled at the hub's two seams — shared by every test that decides.

``hub_get`` answers the catalog with one decider; ``hub_invoke_raw`` answers in Jev's real wire
shape so the dialect's translation runs for real. ``install(monkeypatch, tmp_path)`` wires both
and returns the ``state`` a test steers: ``state["status"]`` (429 → rate limited),
``state["answers"]`` (a ``{question: value}`` override: a float for yes/no, an option for a
choice, a level index for a score) and ``state["invoked"]`` (every call made).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from cryptography.fernet import Fernet

DECIDER = {
    "id": "72575461-9352-4cdb-b2e7-a53be3e3d6e3",
    "name": "Jev (TypeSafe)",
    "kinds": ["decision"],
    "target": {"base_url": "https://api.typesafe.ai"},
}


def jev_answers(wire: dict, overrides: dict[str, Any] | None = None) -> dict:
    """What Jev answers, in its own shape: the first option, a mid score, a likely yes — or what
    ``overrides`` says for a question by name."""
    overrides = overrides or {}
    answers = {}
    for name, q in wire["questions"].items():
        given = overrides.get(name)
        if q["type"] == "choice":
            keys = list(q["criteria"])
            chosen = given if isinstance(given, str) and given in keys else keys[0]
            sure = 0.97
            answers[name] = {
                "type": "choice",
                "choice": chosen,
                "confidence": sure,
                "probabilities": {k: (sure if k == chosen else (1 - sure) / max(1, len(keys) - 1)) for k in keys},
            }
        elif q["type"] == "score":
            levels = list(q["criteria"])
            score = float(given) if isinstance(given, (int, float)) else 1.0
            answers[name] = {
                "type": "score",
                "score": score,
                "confidence": 0.7,
                "legend": {str(i): lvl for i, lvl in enumerate(levels)},
                "probabilities": {str(i): (0.7 if i == int(round(score)) else 0.1) for i in range(len(levels))},
            }
        else:
            prob = float(given) if isinstance(given, (int, float)) else 0.9
            answers[name] = {"type": "noul", "noul": prob}
    return {"model": "jev-1.13.0", "answers": answers, "usage": {"input_tokens": 300, "output_tokens": 0}}


def seams(state: dict[str, Any]):
    """The two hub functions, doubled, steered by ``state`` — for a test's monkeypatch, or for a
    running backend that sets them itself (``tests/e2e/mock_worker_backend.py``)."""

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        if entity_type != "api_endpoint":
            return {"data": []}
        return [DECIDER] if action == "catalog" else {"data": []}

    async def _invoke(entity_type, entity_id, sub_path, payload, **kwargs):
        state["invoked"].append((entity_id, sub_path))
        if state["status"] != 200:
            return state["status"], {"error": "rate_limited", "message": "slow down"}
        return 200, jev_answers(payload, state["answers"])

    return _hub_get, _invoke


def install(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *, instance: str = "decisiondouble") -> dict:
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", instance)
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
    state: dict[str, Any] = {"status": 200, "invoked": [], "answers": {}}
    _hub_get, _invoke = seams(state)
    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    monkeypatch.setattr(hub_http, "hub_invoke_raw", _invoke)
    return state


def release() -> None:
    from flow_sdk.instance_settings import reset_instance_settings
    from flow_sdk.instance_settings.api_endpoint import _list_cache

    _list_cache.clear()
    reset_instance_settings()


@pytest.fixture
def decision_double(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The doubled Decision API; yields the steerable ``state``."""
    state = install(monkeypatch, tmp_path)
    yield state
    release()
