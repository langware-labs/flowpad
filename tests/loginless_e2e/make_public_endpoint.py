"""Create a PUBLIC hub LLMEndpoint and print its id -- the admin half of the loginless rig.

    HUB=http://localhost:8094 OPENROUTER_API_KEY=... python make_public_endpoint.py

Four hub calls, exactly what ``docs/snippets/llm-endpoints.md`` tells an admin to do: create a
root, give it a provider key, cap it in money, open it. The cap comes BEFORE ``public`` because
the hub refuses to open a budget that has none -- the id is the only credential a public
endpoint has, so its limit is the whole defence.
"""

from __future__ import annotations

import os
import sys

import requests

HUB = os.environ.get("HUB", "http://localhost:8094").rstrip("/")
EMAIL = os.environ.get("HUB_OWNER_EMAIL", "loginless-owner@local.test")
PASSWORD = os.environ.get("HUB_OWNER_PASSWORD", "owner-pw-1234")
COST_USD_TOTAL = float(os.environ.get("PUBLIC_COST_USD_TOTAL", "1.0"))


def _data(response: requests.Response) -> dict:
    if response.status_code >= 400:
        sys.exit(f"{response.request.method} {response.url} -> {response.status_code}: {response.text[:300]}")
    return response.json().get("data") or {}


def main() -> None:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        sys.exit("OPENROUTER_API_KEY is required: a public endpoint still spends a real provider key")
    requests.post(f"{HUB}/api/v1/signup", json={"name": "owner", "email": EMAIL, "password": PASSWORD})
    token = _data(requests.post(f"{HUB}/api/v1/login/local", json={"email": EMAIL, "password": PASSWORD}))["token"]
    auth = {"Authorization": f"Bearer {token}"}
    graph = f"{HUB}/api/v1/graph/llm_endpoint"

    endpoint = _data(requests.post(graph, headers=auth, json={"name": "loginless demo", "provider": "openrouter"}))
    one = f"{graph}/{endpoint['id']}"
    _data(requests.post(f"{one}/credential", headers=auth, json={"key": key}))
    _data(requests.put(one, headers=auth, json={"limits": {"cost_usd_total": COST_USD_TOTAL}}))
    _data(requests.post(f"{one}/public", headers=auth, json={"enabled": True}))
    print(endpoint["id"])


if __name__ == "__main__":
    main()
