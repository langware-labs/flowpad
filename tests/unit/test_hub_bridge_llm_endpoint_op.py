"""The bridge acts on an ``llm_endpoint`` change the hub pushes.

These frames were already arriving and falling through to the dispatcher's "no handler"
debug line. That is why a box went on spending a budget that had been deleted -- and on
DESKTOP nothing else ever told it: the hub's other route (``configure_llm_endpoint``) dials
into a box by ``ComputeNode`` row, and a desktop install has none.

Everything here enters through ``_on_data_op`` -- the same dispatcher a real hub frame lands
in -- rather than calling the handler directly, so the routing is under test too. A handler
the dispatcher never reaches would pass a direct-call test happily.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.cloud_client.hub_bridge import HubWsBridge

EP = "11111111-2222-4333-8444-555555555555"
OTHER = "99999999-2222-4333-8444-555555555555"
INVOKE = f"/api/v1/graph/llm_endpoint/{EP}/invoke"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "bridgeeptest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()
    reset_instance_settings()


@pytest.fixture(autouse=True)
def _no_hub_calls(monkeypatch):
    """The handler refreshes the listing best-effort; a unit test must not reach the network.

    Patched at the settings module the handler imports, not at the transport, so a refresh
    that started happening through some other path would still be caught by the assertions.
    """
    calls = []

    async def _fetch(*_a, **_k):
        calls.append(1)
        return []

    monkeypatch.setattr("flow_sdk.instance_settings.llm_endpoint.fetch_hub_llm_endpoints", _fetch)
    return calls


def _frame(op: str, eid: str, data: dict | None = None) -> dict:
    return {"op": op, "to_entity": f"llm_endpoint-{eid}", "data": data if data is not None else {"id": eid}}


def _bind(typeid: str = f"llm_endpoint-{EP}") -> None:
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.set_hub_llm_endpoint(typeid, INVOKE, provider="openrouter", name="Budget")


async def test_deleting_the_bound_endpoint_clears_the_binding(env) -> None:
    """The bug, at the seam that was missing. A binding naming a deleted row makes every
    spawn post to an invoke URL that answers ``Entity ... not found`` -- retried to
    exhaustion, because a bound endpoint outranks an unproven device login."""
    from flow_sdk.instance_settings import llm_endpoint

    _bind()
    assert llm_endpoint.get_hub_llm_endpoint() is not None

    await HubWsBridge()._on_data_op(_frame("delete", EP))

    assert llm_endpoint.get_hub_llm_endpoint() is None, "the binding survived its endpoint being deleted"


async def test_deleting_a_DIFFERENT_endpoint_leaves_the_binding_alone(env) -> None:
    """Only the one we are actually spending. A user may hold a role on several budgets, and
    deleting one they are not bound to must not unfund the box."""
    from flow_sdk.instance_settings import llm_endpoint

    _bind()
    await HubWsBridge()._on_data_op(_frame("delete", OTHER))
    assert llm_endpoint.get_hub_llm_endpoint() is not None


async def test_an_update_refreshes_the_listing_without_dropping_the_binding(env, _no_hub_calls) -> None:
    """An edit changes what the budget allows, not whether it exists."""
    from flow_sdk.instance_settings import llm_endpoint

    _bind()
    await HubWsBridge()._on_data_op(_frame("update", EP, {"id": EP, "name": "renamed"}))

    assert llm_endpoint.get_hub_llm_endpoint() is not None, "an edit unbound the box"
    assert _no_hub_calls, "the listing was not refreshed after a change"


async def test_a_soft_delete_is_treated_as_a_delete(env) -> None:
    """``deleted_at`` in the payload is the other spelling; the sibling handlers read it too."""
    from flow_sdk.instance_settings import llm_endpoint

    _bind()
    await HubWsBridge()._on_data_op(_frame("update", EP, {"id": EP, "deleted_at": "2026-09-03T00:00:00Z"}))
    assert llm_endpoint.get_hub_llm_endpoint() is None


async def test_a_share_refreshes_the_listing_on_an_unbound_box(env, _no_hub_calls) -> None:
    """The create/share case: nothing is bound yet, and the point is that the newly available
    budget becomes visible without the user opening a screen."""
    await HubWsBridge()._on_data_op(_frame("create", OTHER))
    assert _no_hub_calls, "a new budget did not refresh what this box may spend"
