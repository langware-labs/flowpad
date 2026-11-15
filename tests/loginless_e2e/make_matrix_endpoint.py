"""Create the PUBLIC entry the loginless family matrix spends, and print its id.

    HUB=http://localhost:8094 OPENROUTER_API_KEY=... python make_matrix_endpoint.py

One id funds every cell. Behind it, two roots in fallback order:

* **Vertex first** (service-account JSON, so it can reach everything Vertex serves) — narrowed by
  ``models_allow`` to exactly the slugs it serves, so every other model skips it.
* **OpenRouter second** — an identity ``model_map`` over every matrix slug makes it the explicit
  cross-provider fallback the hub's router requires. It takes what the current Vertex adapter
  cannot serve: codex's Responses wire and models outside the Vertex root's declared inventory.

The entry is an allocation off the Vertex root with a money cap, then made public: its id is the
only credential the box ever holds, so the cap is the whole defence.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests

HUB = os.environ.get("HUB", "http://localhost:8094").rstrip("/")
EMAIL = os.environ.get("HUB_OWNER_EMAIL", "matrix-owner@local.test")
PASSWORD = os.environ.get("HUB_OWNER_PASSWORD", "owner-pw-1234")
COST_USD_TOTAL = float(os.environ.get("PUBLIC_COST_USD_TOTAL", "10.0"))
MAX_OUTPUT = int(os.environ.get("PUBLIC_MAX_TOKENS_CEILING", "16384"))
VERTEX_SA = Path(os.environ.get("VERTEX_SA_JSON", Path.home() / ".flow/rigs/vertex-llm/vertex-sa.json"))
GCP_PROJECT = os.environ.get("GCP_PROJECT", "my-gcp-project")
VERTEX_BASE = os.environ.get(
    "VERTEX_BASE_URL", f"https://aiplatform.googleapis.com/v1/projects/{GCP_PROJECT}/locations/global"
)
#: Refreshed 2026-11-14 against Google's current MaaS documentation, not OpenRouter availability:
#: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/capabilities/thinking
#: Kimi K2 Thinking, GLM 4.7/5 and GPT OSS 20B MaaS retired on 2026-10-21:
#: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/deprecations/open-models
#: Those models must not be attempted on Vertex just because OpenRouter still lists them.
VERTEX_SLUGS = [
    s
    for s in os.environ.get(
        "VERTEX_SLUGS",
        "z-ai/glm-5.2,openai/gpt-oss-120b",
    ).split(",")
    if s
]
#: Every slug the matrix spends. Was ``model_tiers.FAMILY_TIERS``; the ``<family>:<size>`` syntax is gone
#: from the SDK (an endpoint declares its sizes now), so the list lives here.
MATRIX_MODELS = {
    # OpenRouter /api/v1/models/<slug>/endpoints checked 2026-11-14: K2 Thinking has
    # only Novita, which this rig deliberately excludes. All three replacements
    # have non-Novita tool-capable hosts and a known hub price (K3.1 Pro does not);
    # keep three distinct cells, not aliases.
    "kimi": {"sm": "moonshotai/kimi-k2.5", "md": "moonshotai/kimi-k2.6", "lg": "moonshotai/kimi-k3"},
    "glm": {"sm": "z-ai/glm-4.7", "md": "z-ai/glm-5.2", "lg": "z-ai/glm-5.3"},
    "openai": {"sm": "openai/gpt-oss-20b", "md": "openai/gpt-oss-120b", "lg": "openai/gpt-5"},
    "claude": {
        "sm": "anthropic/claude-haiku-5.5",
        "md": "anthropic/claude-sonnet-4.6",
        "lg": "anthropic/claude-opus-4.8",
    },
}
MATRIX_SLUGS = [slug for sizes in MATRIX_MODELS.values() for slug in sizes.values()]


def matrix_cells(families: str, sizes: str) -> list[tuple[str, str, str]]:
    """Fixture-owned family labels resolve to explicit slugs, never SDK ``family:size`` syntax."""
    chosen_families, chosen_sizes = families.split(), sizes.split()
    if not chosen_families or not chosen_sizes:
        raise ValueError("families and sizes must select at least one cell")
    if len(set(chosen_families)) != len(chosen_families) or len(set(chosen_sizes)) != len(chosen_sizes):
        raise ValueError("duplicate families or sizes")
    try:
        return [(family, size, MATRIX_MODELS[family][size]) for family in chosen_families for size in chosen_sizes]
    except KeyError as exc:
        raise ValueError(f"unknown family or size: {exc.args[0]}") from exc


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
    every_slug = sorted(set(MATRIX_SLUGS))

    def root(body: dict, credential: str, filters: dict) -> str:
        made = _data(requests.post(graph, headers=auth, json=body))
        _data(requests.post(f"{graph}/{made['id']}/credential", headers=auth, json={"key": credential}))
        _data(requests.put(f"{graph}/{made['id']}", headers=auth, json={"filters": filters}))
        return made["id"]

    vertex = root(
        {
            "name": "matrix vertex",
            "provider": "vertex",
            "base_url": VERTEX_BASE,
            # The fixture narrows this root to Model Garden models. Its sizes must
            # belong to that same inventory, not the provider's Gemini defaults.
            "tiers": {
                "sm": MATRIX_MODELS["openai"]["md"],
                "md": MATRIX_MODELS["openai"]["md"],
                "lg": MATRIX_MODELS["glm"]["md"],
            },
        },
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
    if len(sys.argv) == 4 and sys.argv[1] == "--cells":
        try:
            for cell in matrix_cells(sys.argv[2], sys.argv[3]):
                print(" ".join(cell))
        except ValueError as exc:
            sys.exit(str(exc))
    elif len(sys.argv) == 1:
        main()
    else:
        sys.exit("usage: make_matrix_endpoint.py [--cells 'families' 'sizes']")
