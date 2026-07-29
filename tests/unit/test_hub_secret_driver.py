"""Resolving a declaration whose value lives on the hub.

Replaces the stub that returned None for every hub-kind declaration. What is
pinned here is mostly restraint: no caching (so a revoke takes effect at the
next spawn), and can_resolve must NOT hit the gated value route (the Secrets
card calls it per secret on every render).
"""

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.drivers.hub_secret_driver import HubSecretDriver
from flow_sdk.builtin.secret_origin_driver import SecretProvideUnsupported, get_secret_origin_driver
from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER

PROJECT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"


def _locator(**kwargs):
    return SECRET_ORIGIN_ADAPTER.validate_python({"kind": "flowpad-hub", **kwargs})


def test_the_registry_now_serves_a_real_driver():
    driver = get_secret_origin_driver("flowpad-hub")

    assert isinstance(driver, HubSecretDriver)


@pytest.mark.asyncio
async def test_resolve_returns_the_hub_value(monkeypatch):
    seen = {}

    async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, **k):
        seen.update({"entity_id": entity_id, "action": action, "sub_path": sub_path})
        return {"data": {"name": "OPENAI_API_KEY", "value": "sk-from-hub"}}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)
    loc = _locator(project_id=PROJECT, name="OPENAI_API_KEY")

    got = await HubSecretDriver().resolve(loc)

    assert isinstance(got, SecretStr)
    assert got.get_secret_value() == "sk-from-hub"
    assert seen == {"entity_id": PROJECT, "action": "env-var", "sub_path": "OPENAI_API_KEY/value"}


@pytest.mark.asyncio
async def test_a_refusal_resolves_to_nothing_rather_than_raising(monkeypatch):
    """The hub answers 404 for every refusal — not declared, no consent, not in
    scope. A worker spawn must survive that, not crash on it."""

    async def fake_get(*a, **k):
        return None

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)

    assert await HubSecretDriver().resolve(_locator(project_id=PROJECT, name="X")) is None


@pytest.mark.asyncio
async def test_an_unaddressable_locator_never_calls_the_hub(monkeypatch):
    called = []

    async def spy(*a, **k):
        called.append(a)
        return {}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", spy)

    assert await HubSecretDriver().resolve(_locator()) is None
    assert called == []


@pytest.mark.asyncio
async def test_can_resolve_does_not_touch_the_value_route(monkeypatch):
    """The gated route is audited; painting a status chip must not fill that log
    with reads nobody asked for."""
    sub_paths = []

    async def fake_get(entity_type, entity_id=None, action=None, sub_path=None, **k):
        sub_paths.append(sub_path)
        return {"data": [{"name": "OPENAI_API_KEY", "visible_value": "****key"}]}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)
    loc = _locator(project_id=PROJECT, name="OPENAI_API_KEY")

    assert await HubSecretDriver().can_resolve(loc) is True
    assert all(p is None or not str(p).endswith("/value") for p in sub_paths)


@pytest.mark.asyncio
async def test_can_resolve_is_false_when_the_hub_does_not_have_it(monkeypatch):
    async def fake_get(*a, **k):
        return {"data": [{"name": "SOMETHING_ELSE"}]}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", fake_get)

    assert await HubSecretDriver().can_resolve(_locator(project_id=PROJECT, name="NOPE")) is False


@pytest.mark.asyncio
async def test_store_directs_the_caller_at_the_gated_push(monkeypatch):
    """Silently caching locally would create a second copy the hub never sees."""
    with pytest.raises(SecretProvideUnsupported) as excinfo:
        await HubSecretDriver().store(_locator(project_id=PROJECT, name="X"), "sk-1")

    assert "push to cloud" in str(excinfo.value)
