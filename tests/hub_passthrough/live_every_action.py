"""Coverage gate: every registered hub action, called the same way direct and through a desktop,
answers the same status and envelope. Run from the hub repo:

    uv run pytest -p flowpad.hub.tests.conftest -p hub_passthrough_plugin tests/hub_passthrough/live_every_action.py
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import pytest

import hub_passthrough_plugin as hp

ACTIONS = json.loads((Path(__file__).parent / "hub_actions.json").read_text())
_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MISSING = str(uuid.UUID(int=7))


def _calls(a: dict) -> list[tuple[str, str]]:
    typ, _, bare = a["name"].rpartition(".")
    methods = [m for m in a["methods"] if m != "all"] or ["get", "post"]
    if not typ:
        paths = [f"/api/v1/graph/{bare}"]
    else:
        paths = [f"/api/v1/graph/{typ}/{bare}", f"/api/v1/graph/{typ}/{MISSING}/{bare}"]
    return [(m.upper(), p) for m in methods for p in paths]


def _shape(r) -> tuple:
    try:
        body = r.json()
    except ValueError:
        return (r.status_code, "non-json")
    if isinstance(body, dict):
        msg = _ID.sub("<id>", str(body.get("message") or body.get("detail") or ""))
        return (r.status_code, body.get("status"), msg[:200])
    return (r.status_code, type(body).__name__)


@pytest.mark.parametrize("a", ACTIONS, ids=[a["name"] for a in ACTIONS])
async def test_the_action_answers_the_same_through_a_desktop(a, service, alice_token):
    headers = {"Authorization": f"Bearer {alice_token}"}
    direct = hp._state["original"](service, headers=headers)
    proxied = hp._passthrough_client(service, headers=headers)
    async with direct, proxied:
        for method, path in _calls(a):
            kw = {"json": {}} if method in ("POST", "PUT", "PATCH") else {}
            d = await direct.request(method, path, **kw)
            p = await proxied.request(method, path, **kw)
            assert _shape(p) == _shape(d), f"{method} {path}"
