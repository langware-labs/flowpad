"""The one LLM budget live tests may spend: a brand-new user's default allowance on the LOCAL hub.

The QA program funds every live LLM test through a hub endpoint whose root is the hub's own
Vertex-backed global root -- never an OpenRouter / Anthropic / OpenAI key on this box. A fresh
signup's first contact (``GET graph/bootstrap``) mints its default allowance, chained to that root,
and the allowance's ``chain`` reports the slug each size (``sm``/``md``/``lg``) runs as.

Sync on purpose: module-scoped fixtures cannot hold anything bound to one test's event loop.
``tests/long_tests/conftest.py::_sign_in_to_the_local_hub`` is the async twin for per-test use.
Only a LOCAL hub is ever used: signing in writes this box's hub credentials.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
import pytest

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def local_hub_url() -> str:
    """``FLOWPAD_HUB_URL`` when it names a local hub, else SKIP (never sign in anywhere real)."""
    hub = (os.environ.get("FLOWPAD_HUB_URL") or "").rstrip("/")
    if not hub:
        pytest.skip("FLOWPAD_HUB_URL is not set -- point this at a LOCAL Vertex-funded hub")
    if urlparse(hub).hostname not in _LOCAL_HOSTS:
        pytest.skip(f"refusing to run against a non-local hub: {hub}")
    return hub


@dataclass(frozen=True)
class VertexHubBudget:
    hub_url: str
    #: ``llm_endpoint-<uuid>`` of the signed-in user's default allowance.
    allowance: str
    #: ``{"sm": slug, "md": slug, "lg": slug}`` -- what the hub runs each size as on this chain.
    tiers: dict[str, str]


def graph_path(typeid: str) -> str:
    """``"llm_endpoint-<uuid>"`` -> ``"llm_endpoint/<uuid>"``, the shape graph routes take."""
    return typeid.replace("-", "/", 1)


def hub_client(hub_url: str) -> httpx.Client:
    """A sync client authenticated as this box's current hub login."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

    return httpx.Client(
        base_url=f"{hub_url}/api/v1", headers={"Authorization": f"Bearer {resolve_hub_api_key()}"}, timeout=60.0
    )


def effective_tiers(client: httpx.Client, typeid: str) -> dict[str, str]:
    chain = client.get(f"/graph/{graph_path(typeid)}/chain")
    assert chain.status_code == 200, chain.text
    data = chain.json()["data"]
    assert data["paths"] and len(data["paths"][0]) >= 2, f"{typeid} draws on no root: {data['paths']}"
    return {size: (tier or {}).get("model") for size, tier in (data.get("effective_tiers") or {}).items()}


def sign_up_and_fund(label: str) -> VertexHubBudget:
    """Sign this box in to the local hub as a NEW user and return that user's default allowance.

    A new user, not ``/login/local``: the shared local account collects every budget earlier runs
    made for it, while a fresh one sees exactly one -- the allowance the hub minted for it, funded
    by the hub's root. SKIPs (an environment gap, not a failure) when the hub is unreachable or
    offers no allowance.
    """
    from flow_sdk.config import default_service_config
    from tests.hub_tests._local_login import login_as

    hub = local_hub_url()
    default_service_config.flowpad_hub_url = hub
    account = {"email": f"vx-{uuid.uuid4().hex[:12]}@local.test", "password": f"pw-{uuid.uuid4().hex[:16]}"}
    try:
        with httpx.Client(base_url=f"{hub}/api/v1", timeout=30.0) as anon:
            anon.post("/signup", json={**account, "name": label})
            login = anon.post("/login", json=account)
    except httpx.HTTPError as exc:
        pytest.skip(f"local hub {hub} unreachable ({type(exc).__name__})")
    if login.status_code != 200:
        pytest.skip(f"local hub login failed: {login.status_code} {login.text[:200]}")
    login_as(login.json()["data"])
    with hub_client(hub) as client:
        client.get("/graph/bootstrap")  # mints the default allowance on first contact
        listed = client.get("/graph/llm_endpoint")
        assert listed.status_code == 200, listed.text
        mine = [row for row in listed.json()["data"] if str(row.get("name", "")).startswith(account["email"])]
        if not mine:
            pytest.skip(f"the local hub minted no default allowance for a new user ({hub})")
        allowance = f"llm_endpoint-{mine[0]['id']}"
        return VertexHubBudget(hub_url=hub, allowance=allowance, tiers=effective_tiers(client, allowance))


def allocate(client: httpx.Client, parent: str, name: str, cost_usd_total: float) -> str:
    """A sub-budget off ``parent`` (the caller's own allowance) -- its own counters, same root."""
    made = client.post(
        f"/graph/{graph_path(parent)}/allocate", json={"name": name, "limits": {"cost_usd_total": cost_usd_total}}
    )
    assert made.status_code == 200, made.text
    return f"llm_endpoint-{made.json()['data']['id']}"


def public_endpoint_for_containers(label: str, cost_usd_total: float) -> tuple[str, str]:
    """A capped PUBLIC endpoint on the local hub, funded by Vertex, and the hub URL a container dials.

    For docker tests: a clean container holds no login and no key, so it is funded the way a
    loginless box is (``flow llm user use <id> --hub <url>``). ``VERTEX_ROOT_ID`` names the hub's
    Vertex root to allocate from (``tests/loginless_e2e/make_public_endpoint.py``). The container
    reaches the host's hub as ``host.docker.internal`` (run it with
    ``--add-host=host.docker.internal:host-gateway``). SKIPs without a local hub or Vertex funding.
    """
    import importlib.util
    from pathlib import Path

    hub = local_hub_url()
    if not (os.environ.get("VERTEX_ROOT_ID") or os.environ.get("VERTEX_SA_JSON")):
        pytest.skip("no Vertex funding: set VERTEX_ROOT_ID (the hub's Vertex root) or VERTEX_SA_JSON")
    path = Path(__file__).resolve().parents[1] / "loginless_e2e" / "make_public_endpoint.py"
    spec = importlib.util.spec_from_file_location("make_public_endpoint", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    saved = os.environ.pop("OPENROUTER_API_KEY", None)  # Vertex only: never an OpenRouter key
    try:
        endpoint_id = module.create_public_endpoint(hub, cost_usd_total=cost_usd_total)
    finally:
        if saved is not None:
            os.environ["OPENROUTER_API_KEY"] = saved
    in_container = hub.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")
    return endpoint_id, in_container
