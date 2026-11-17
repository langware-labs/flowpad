"""Create a PUBLIC hub LLMEndpoint and print its id -- the admin half of the loginless rig.

    HUB=http://localhost:8094 OPENROUTER_API_KEY=... python make_public_endpoint.py
    HUB=http://localhost:8094 VERTEX_SA_JSON=<file or JSON> python make_public_endpoint.py

With no OpenRouter key the budget is Vertex-funded (the QA program funds LLM tests through Vertex,
never an OpenRouter key on the test box): ``VERTEX_ROOT_ID`` names a Vertex root already on the hub
and the public entry is a capped allocation off it; without it a Vertex root is made from
``VERTEX_SA_JSON`` (an account the hub lets set a ``base_url``).

Four hub calls, exactly what ``docs/snippets/llm-endpoints.md`` tells an admin to do: create a
root, give it a provider key, cap it in money, open it. The cap comes BEFORE ``public`` because
the hub refuses to open a budget that has none -- the id is the only credential a public
endpoint has, so its limit is the whole defence.
"""

from __future__ import annotations

import json
import os
import sys

import requests

HUB = os.environ.get("HUB", "http://localhost:8094").rstrip("/")
EMAIL = os.environ.get("HUB_OWNER_EMAIL", "loginless-owner@local.test")
PASSWORD = os.environ.get("HUB_OWNER_PASSWORD", "owner-pw-1234")
COST_USD_TOTAL = float(os.environ.get("PUBLIC_COST_USD_TOTAL", "1.0"))
#: OpenRouter hosts this budget will not pay. Novita answers ``qwen/qwen3-coder-30b-a3b-instruct``
#: with an EMPTY completion for about a third of requests (proven 2026-09-18: 26 of 26 empty
#: answers were Novita's, 66 of 66 from other hosts had text), which a harness shows as a finished
#: turn with nothing said. Set it empty to see that for yourself.
PROVIDERS_IGNORE = [name for name in os.environ.get("PUBLIC_PROVIDERS_IGNORE", "Novita").split(",") if name]


def _data(response: requests.Response) -> dict:
    if response.status_code >= 400:
        sys.exit(f"{response.request.method} {response.url} -> {response.status_code}: {response.text[:300]}")
    return response.json().get("data") or {}


def owner_token(hub: str = HUB) -> str:
    """The admin's hub token: a real login (``/login``), else the dev ``/login/local``."""
    for path in ("/login", "/login/local"):
        response = requests.post(f"{hub}/api/v1{path}", json={"email": EMAIL, "password": PASSWORD})
        if response.status_code == 200:
            data = response.json().get("data") or {}
            return data.get("api_key") or data["token"]
    sys.exit(f"cannot sign in to {hub} as {EMAIL}")


def _vertex_root() -> tuple[dict, str] | None:
    """``(create body, credential)`` for a Vertex root, or None without a service account."""
    raw = os.environ.get("VERTEX_SA_JSON", "").strip()
    if not raw:
        return None
    sa = raw if raw.startswith("{") else open(raw, encoding="utf-8").read().strip()
    project = os.environ.get("GCP_PROJECT") or json.loads(sa)["project_id"]
    base = os.environ.get("VERTEX_BASE_URL", f"https://aiplatform.googleapis.com/v1/projects/{project}/locations/global")
    return {"name": "loginless demo", "provider": "vertex", "base_url": base}, sa


def create_public_endpoint(hub: str = HUB, cost_usd_total: float = COST_USD_TOTAL) -> str:
    """The four admin calls; returns the public endpoint's id. Vertex when there is no OpenRouter key."""
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    vertex = None if key else _vertex_root()
    if not key and vertex is None and not os.environ.get("VERTEX_ROOT_ID"):
        sys.exit("OPENROUTER_API_KEY or VERTEX_SA_JSON is required: a public endpoint still spends a real provider")
    requests.post(f"{hub}/api/v1/signup", json={"name": "owner", "email": EMAIL, "password": PASSWORD})
    token = owner_token(hub)
    auth = {"Authorization": f"Bearer {token}"}
    graph = f"{hub}/api/v1/graph/llm_endpoint"

    root_id = "" if key else os.environ.get("VERTEX_ROOT_ID", "").strip()
    if root_id:
        entry = _data(
            requests.post(
                f"{graph}/{root_id}/allocate",
                headers=auth,
                json={"name": "loginless demo", "limits": {"cost_usd_total": cost_usd_total}},
            )
        )["id"]
        _data(requests.post(f"{graph}/{entry}/public", headers=auth, json={"enabled": True}))
        return entry
    body, credential = vertex or ({"name": "loginless demo", "provider": "openrouter"}, key)
    endpoint = _data(requests.post(graph, headers=auth, json=body))
    one = f"{graph}/{endpoint['id']}"
    _data(requests.post(f"{one}/credential", headers=auth, json={"key": credential}))
    filters = {} if vertex else {"providers_ignore": PROVIDERS_IGNORE}
    _data(requests.put(one, headers=auth, json={"limits": {"cost_usd_total": cost_usd_total}, "filters": filters}))
    _data(requests.post(f"{one}/public", headers=auth, json={"enabled": True}))
    return endpoint["id"]


def main() -> None:
    print(create_public_endpoint())


if __name__ == "__main__":
    main()
