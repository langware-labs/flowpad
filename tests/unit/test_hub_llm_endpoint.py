"""The hub ``LLMEndpoint`` binding on the box: settings, provider plumbing, and
the bind/unbind that flips the harnesses.

Isolation matches tests/unit/test_api_auth_binding.py: a temp FLOW_HOME + fresh
instance singleton + SOD_ENC_KEY so the credential store resolves headlessly.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

INVOKE_PATH = "/api/v1/graph/llm_endpoint/ep1/invoke"


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "hubendpointtest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint, reset_instance_settings

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    reset_instance_settings()
    llm_endpoint.reset_cache()
    yield
    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()
    reset_instance_settings()


@pytest.fixture(autouse=True)
async def _reset_harness_auth_mode():
    yield
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    for worker in ("claude", "codex", "copilot"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "auth_mode", "device") != "device":
            cap.auth_mode = "device"
            cap.api_provider = None
            await cap.save(notify=False)


def _login() -> None:
    from flow_sdk.cli.auth.hub_login import set_api_key

    set_api_key("fp-hub-key")


# ── settings ────────────────────────────────────────────────────────────────


def test_settings_round_trip(env) -> None:
    from flow_sdk.instance_settings import llm_endpoint

    assert llm_endpoint.get_hub_llm_endpoint() is None
    assert llm_endpoint.hub_llm_endpoint_invoke_url() is None

    bound = llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH + "/", provider="openrouter", name="OR")
    assert bound.invoke_path == INVOKE_PATH  # trailing slash normalised
    assert llm_endpoint.get_hub_llm_endpoint() == bound
    # Absolute URL = hub ORIGIN (no /api/v1) + the full hub path.
    assert llm_endpoint.hub_llm_endpoint_invoke_url() == "https://hub.test" + INVOKE_PATH

    # Survives the memo being dropped: it is persisted, not in-memory only.
    llm_endpoint.reset_cache()
    assert llm_endpoint.get_hub_llm_endpoint() == bound

    assert llm_endpoint.clear_hub_llm_endpoint() is True
    assert llm_endpoint.get_hub_llm_endpoint() is None
    assert llm_endpoint.clear_hub_llm_endpoint() is False


def test_settings_reject_garbage(env) -> None:
    from flow_sdk.instance_settings import llm_endpoint

    with pytest.raises(ValueError):
        llm_endpoint.set_hub_llm_endpoint("", INVOKE_PATH)
    with pytest.raises(ValueError):
        llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", "https://evil.example/invoke")
    with pytest.raises(ValueError):
        llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", "graph/no-leading-slash")


# ── lm_api plumbing for the FLOWPAD provider ─────────────────────────────────


def test_get_lm_api_flowpad_is_hub_login_iff_bound(env) -> None:
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, get_lm_api

    _login()
    assert get_lm_api(LMApiProvider.FLOWPAD) is None  # logged in, but unbound
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH)
    assert get_lm_api(LMApiProvider.FLOWPAD) == "fp-hub-key"
    assert get_lm_api("flowpad") == "fp-hub-key"


def test_get_lm_api_flowpad_none_when_logged_out(env) -> None:
    from flow_sdk.cli.auth.hub_login import delete_api_key
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, get_lm_api

    delete_api_key()
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH)
    assert get_lm_api(LMApiProvider.FLOWPAD) is None


def test_set_lm_api_flowpad_is_refused(env) -> None:
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    with pytest.raises(ValueError):
        set_lm_api("anything", LMApiProvider.FLOWPAD)


async def test_delete_lm_api_flowpad_leaves_binding(env) -> None:
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, delete_lm_api

    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH)
    await delete_lm_api(LMApiProvider.FLOWPAD)
    assert llm_endpoint.get_hub_llm_endpoint() is not None  # the hub owns unbinding


def test_list_lm_api_shows_managed_row_only_when_bound(env) -> None:
    from flow_sdk.cli.auth.hub_login import delete_api_key
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import list_lm_api

    assert [r for r in list_lm_api() if r["provider"] == "flowpad"] == []

    _login()
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH)
    rows = [r for r in list_lm_api() if r["provider"] == "flowpad"]
    assert rows == [
        {"provider": "flowpad", "configured": True, "created_at": None, "managed": True, "detail": "llm_endpoint:ep1"}
    ]

    # Bound but logged out: listed, not configured.
    delete_api_key()
    (row,) = [r for r in list_lm_api() if r["provider"] == "flowpad"]
    assert row["configured"] is False and row["managed"] is True


async def test_validate_flowpad_unbound_needs_no_network(env) -> None:
    from flow_sdk.lm_api import LMApiProvider, validate_lm_api

    _login()
    # Unbound: no key at all for this provider.
    assert await validate_lm_api(LMApiProvider.FLOWPAD) == {"valid": False, "message": "No key configured"}
    # In-hand key but unbound: no probe target, no network.
    assert (await validate_lm_api(LMApiProvider.FLOWPAD, key="x"))["message"] == "No hub LLM endpoint bound"


def test_validate_and_models_resolvers_target_the_endpoint(env) -> None:
    from flow_sdk.cli.auth.lm_api_keys import _models_endpoint, _validate_endpoint
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import LMApiProvider

    assert _validate_endpoint(LMApiProvider.FLOWPAD) is None
    assert _models_endpoint(LMApiProvider.FLOWPAD) is None
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH)
    url, build_headers = _validate_endpoint(LMApiProvider.FLOWPAD)
    assert url == "https://hub.test" + INVOKE_PATH + "/v1/models"
    assert build_headers("k") == {"Authorization": "Bearer k"}
    assert _models_endpoint(LMApiProvider.FLOWPAD) == (url, True)
    # The static providers are untouched.
    assert _validate_endpoint(LMApiProvider.OPENROUTER)[0] == "https://openrouter.ai/api/v1/key"


# ── bind / unbind ────────────────────────────────────────────────────────────


async def _harness_states() -> dict[str, tuple[str, str | None]]:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    out = {}
    for worker in ("claude", "codex", "copilot"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        out[worker] = (cap.auth_mode, cap.api_provider)
    return out


async def test_bind_flips_harnesses_and_spawns_through_the_hub(env) -> None:
    from types import SimpleNamespace

    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (
        bind_hub_llm_endpoint,
        hub_llm_endpoint_status,
    )

    _login()
    status = await bind_hub_llm_endpoint(
        {"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH, "provider": "openrouter", "name": "OR"}
    )
    assert status["endpoint_typeid"] == "llm_endpoint:ep1"
    assert status["invoke_url"] == "https://hub.test" + INVOKE_PATH
    assert status["hub_logged_in"] is True
    assert len(status["active_for"]) == 3

    assert all(state == ("api", "flowpad") for state in (await _harness_states()).values())
    assert await hub_llm_endpoint_status() == status

    process = SimpleNamespace(driver=SimpleNamespace(name="claude"), cli_config={"model": "sm"})
    auth = await resolve_worker_api_auth(process)
    assert auth.env["ANTHROPIC_BASE_URL"] == "https://hub.test" + INVOKE_PATH
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"


async def test_bind_is_idempotent(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import bind_hub_llm_endpoint

    _login()
    payload = {"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH}
    first = await bind_hub_llm_endpoint(payload)
    second = await bind_hub_llm_endpoint(payload)
    assert first == second


async def test_bind_requires_login(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (
        HubEndpointBindError,
        bind_hub_llm_endpoint,
    )
    from flow_sdk.cli.auth.hub_login import delete_api_key
    from flow_sdk.instance_settings import llm_endpoint

    delete_api_key()
    with pytest.raises(HubEndpointBindError) as exc:
        await bind_hub_llm_endpoint({"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH})
    assert exc.value.status_code == 409
    assert llm_endpoint.get_hub_llm_endpoint() is None  # nothing persisted
    assert all(state == ("device", None) for state in (await _harness_states()).values())


async def test_bind_rejects_malformed_payload(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (
        HubEndpointBindError,
        bind_hub_llm_endpoint,
    )

    _login()
    for payload in (
        {},
        {"endpoint_typeid": "x"},
        {"invoke_path": INVOKE_PATH},
        {"endpoint_typeid": "x", "invoke_path": "http://evil/"},
    ):
        with pytest.raises(HubEndpointBindError) as exc:
            await bind_hub_llm_endpoint(payload)
        assert exc.value.status_code == 400


async def test_unbind_reverts_to_device(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import (
        bind_hub_llm_endpoint,
        unbind_hub_llm_endpoint,
    )
    from flow_sdk.instance_settings import llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, get_lm_api

    _login()
    await bind_hub_llm_endpoint({"endpoint_typeid": "llm_endpoint:ep1", "invoke_path": INVOKE_PATH})
    result = await unbind_hub_llm_endpoint()
    assert result["was_bound"] is True
    assert len(result["reverted"]) == 3
    assert result["endpoint_typeid"] is None and result["active_for"] == []
    assert llm_endpoint.get_hub_llm_endpoint() is None
    assert get_lm_api(LMApiProvider.FLOWPAD) is None
    assert all(state == ("device", None) for state in (await _harness_states()).values())


async def test_unbind_leaves_other_api_providers_alone(env) -> None:
    """A harness the user put on OpenRouter is not touched by the hub unbinding."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import unbind_hub_llm_endpoint
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind("codex"))
    cap.auth_mode = "api"
    cap.api_provider = "openrouter"
    await cap.save(notify=False)

    result = await unbind_hub_llm_endpoint()
    assert result["was_bound"] is False and result["reverted"] == []
    assert (await _harness_states())["codex"] == ("api", "openrouter")
