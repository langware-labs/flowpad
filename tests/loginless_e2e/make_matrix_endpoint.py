"""Create the PUBLIC entry the loginless family matrix spends, and print its id.

    HUB=http://localhost:8094 OPENROUTER_API_KEY=... python make_matrix_endpoint.py

One id funds every cell. Behind it, two roots in fallback order:

* **Vertex first** (service-account JSON, so it can reach everything Vertex serves) — narrowed by
  ``models_allow`` to exactly the slugs it serves, so every other model skips it.
* **OpenRouter second** — an identity ``model_map`` over every matrix slug makes it the explicit
  cross-provider fallback the hub's router requires. It takes what Vertex cannot: codex (Responses
  API), claude-code on non-Claude models (the messages wire), the claude family, and the ``lg``
  slugs Vertex has no model for.

The entry is an allocation off the Vertex root with a money cap, then made public: its id is the
only credential the box ever holds, so the cap is the whole defence.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests

from flow_sdk.builtin.agentic_process.model_tiers import FAMILY_TIERS

HUB = os.environ.get("HUB", "http://localhost:8094").rstrip("/")
EMAIL = os.environ.get("HUB_OWNER_EMAIL", "matrix-owner@local.test")
PASSWORD = os.environ.get("HUB_OWNER_PASSWORD", "owner-pw-1234")
COST_USD_TOTAL = float(os.environ.get("PUBLIC_COST_USD_TOTAL", "10.0"))
MAX_OUTPUT = int(os.environ.get("PUBLIC_MAX_TOKENS_CEILING", "16384"))
VERTEX_SA = Path(os.environ.get("VERTEX_SA_JSON", Path.home() / ".flow/rigs/vertex-llm/vertex-sa.json"))
VERTEX_BASE = os.environ.get(
    "VERTEX_BASE_URL", "https://aiplatform.googleapis.com/v1/projects/langware/locations/global"
)
#: What the Vertex root serves of the matrix (probed 2026-10-03; kimi-k2.5 is not on Vertex). Override
#: with a comma list when a probe shows Vertex refusing one -- it then falls to OpenRouter.
VERTEX_SLUGS = [
    s
    for s in os.environ.get(
        "VERTEX_SLUGS",
        "moonshotai/kimi-k2-thinking,z-ai/glm-4.7,z-ai/glm-5,openai/gpt-oss-20b,openai/gpt-oss-120b",
    ).split(",")
    if s
]


def _data(response: requests.Response) -> dict:
    if response.status_code >= 400:
        sys.exit(f"{response.request.method} {response.url} -> {response.status_code}: {response.text[:300]}")
    return response.json().get("data") or {}


def main() -> None:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key or not VERTEX_SA.is_file():
        sys.exit(f"needs OPENROUTER_API_KEY and the Vertex service-account JSON at {VERTEX_SA}")
    requests.post(f"{HUB}/api/v1/signup", json={"name": "owner", "email": EMAIL, "password": PASSWORD})
    token = _data(requests.post(f"{HUB}/api/v1/login/local", json={"email": EMAIL, "password": PASSWORD}))["token"]
    auth = {"Authorization": f"Bearer {token}"}
    graph = f"{HUB}/api/v1/graph/llm_endpoint"
    every_slug = sorted({slug for sizes in FAMILY_TIERS.values() for slug in sizes.values()})

    def root(body: dict, credential: str, filters: dict) -> str:
        made = _data(requests.post(graph, headers=auth, json=body))
        _data(requests.post(f"{graph}/{made['id']}/credential", headers=auth, json={"key": credential}))
        _data(requests.put(f"{graph}/{made['id']}", headers=auth, json={"filters": filters}))
        return made["id"]

    vertex = root(
        {"name": "matrix vertex", "provider": "vertex", "base_url": VERTEX_BASE},
        VERTEX_SA.read_text().strip(),
        {"models_allow": VERTEX_SLUGS},
    )
    openrouter = root(
        {"name": "matrix openrouter", "provider": "openrouter"},
        key,
        {"model_map": {slug: slug for slug in every_slug}, "providers_ignore": ["Novita"]},
    )
    entry = _data(
        requests.post(
            f"{graph}/{vertex}/allocate",
            headers=auth,
            json={"name": "loginless matrix", "limits": {"cost_usd_total": COST_USD_TOTAL}},
        )
    )["id"]
    _data(requests.post(f"{graph}/{openrouter}/allocate", headers=auth, json={"into": f"llm_endpoint-{entry}"}))
    # A harness that names no output cap (copilot) is priced upstream at the model's maximum; the
    # ceiling makes the hub ask for this much on its behalf.
    _data(requests.put(f"{graph}/{entry}", headers=auth, json={"filters": {"max_tokens_ceiling": MAX_OUTPUT}}))
    _data(requests.post(f"{graph}/{entry}/public", headers=auth, json={"enabled": True}))
    print(entry)


if __name__ == "__main__":
    main()
