"""The hub ``LLMEndpoint`` binding on the box: settings, provider plumbing, and
the bind/unbind that flips the harnesses.

Isolation matches tests/unit/test_api_auth_binding.py: a temp FLOW_HOME + fresh
instance singleton + SOD_ENC_KEY so the credential store resolves headlessly.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import HUB_ENDPOINT_HARNESSES

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


async def _forget_probed_login_states() -> None:
    """Put the harnesses back to "nobody has asked".

    ``login_state`` used to be ``None`` ambiently, because the only thing that ever wrote it
    was the login modal's button. The startup sweep now RESOLVES it
    (``discovery._resolve_login_states``), and the suite shares one session DB — so a real
    probe run by any earlier test leaks a verdict into every later one. The tests below are
    about the UNPROBED box specifically, so they have to state that precondition instead of
    inheriting it.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    for worker in ("claude", "codex", "copilot", "opencode"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "login_state", None) is not None:
            cap.login_state = None
            cap.login_message = None
            await cap.save(notify=False)


@pytest.fixture(autouse=True)
async def _reset_harness_auth_mode():
    # Clear on the way IN as well as out: the startup sweep now resolves login_state, and a
    # probe run by any earlier test in the session leaks its verdict into these.
    await _forget_probed_login_states()
    yield
    await _forget_probed_login_states()
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
        {
            "provider": "flowpad",
            "configured": True,
            "created_at": None,
            "managed": True,
            "detail": "llm_endpoint:ep1",
            # Unnamed binding: the row still carries the key, empty.
            "name": "",
        }
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


async def test_bind_offers_the_endpoint_without_rewriting_the_users_choice(env) -> None:
    """Binding makes the endpoint available and the resolver takes it -- WITHOUT touching
    ``auth_mode``/``api_provider``.

    Binding used to force every hub-capable harness to ``(api, flowpad)`` on every workspace
    open, discarding whatever the user had chosen and keeping no record of it -- while
    ``Capability`` itself documents that seeding must never clobber those fields. It was a
    workaround for a resolver gate that no longer exists. The endpoint still wins here; it
    just wins by being resolved rather than by overwriting a preference.
    """
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
    assert len(status["active_for"]) == len(HUB_ENDPOINT_HARNESSES)

    assert all(state == ("device", None) for state in (await _harness_states()).values()), (
        "binding must not rewrite the user's stored choice"
    )
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


async def test_unbind_withdraws_the_offer(env) -> None:
    """Unbinding removes the endpoint and the resolver falls back down the ladder on its own.

    There is no ``reverted`` list any more because there is nothing to revert: binding stopped
    writing to ``Capability``, so unbinding has nothing of the user's to put back.
    """
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
    assert "reverted" not in result, "nothing is reverted: binding never wrote to Capability"
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
    assert result["was_bound"] is False
    assert (await _harness_states())["codex"] == ("api", "openrouter")


# ── the entity, and the list of what this user may spend ────────────────────


def test_the_entity_mirrors_a_hub_payload_and_ignores_what_it_does_not_model() -> None:
    """The hub serializes more than this projection declares (attribution, expansions). Taking only
    the mirrored fields is what lets the hub grow a field without breaking the picker."""
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    fields = set(LLMEndpoint.model_fields)
    row = {
        "id": "11111111-2222-4333-8444-555555555555",
        "type": "llm_endpoint",
        "name": "bob's dollar",
        "provider": "openrouter",
        "enabled": True,
        "limits": {"cost_usd_total": 1.0},
        "filters": {"models_allow": ["openai/*"]},
        "credential_hint": "",
        "system_default": False,
        # things the hub sends that this projection deliberately does not model
        "created_by": "user-99999999-2222-4333-8444-555555555555",
        "expand": {"roles": ["reader"]},
    }
    endpoint = LLMEndpoint(**{k: v for k, v in row.items() if k in fields})

    assert endpoint.name == "bob's dollar"
    assert endpoint.limits.cost_usd_total == 1.0
    assert endpoint.filters.models_allow == ["openai/*"]
    assert endpoint.invoke_path() == "/api/v1/graph/llm_endpoint/11111111-2222-4333-8444-555555555555/invoke"
    assert not endpoint.is_root, "no credential hint means it draws on something else"
    assert "sources" not in LLMEndpoint.model_fields, (
        "sources is a hub-side relationship since allocation moved to `allocate`; "
        "mirroring one here would be inventing state the box cannot know"
    )


async def test_fetch_is_empty_when_logged_out(env) -> None:
    """A signed-out box has nothing to offer, and says so instead of raising."""
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

    assert await fetch_hub_llm_endpoints() == []


async def test_status_carries_what_the_user_may_spend(env) -> None:
    """The list rides the status the harness modal already polls, beside the pushed binding."""
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import hub_llm_endpoint_status

    status = await hub_llm_endpoint_status()
    assert status["available"] == [], "logged out: nothing to choose from, and no error"
    assert status["endpoint_typeid"] is None and status["hub_logged_in"] is False


async def test_the_hub_initiated_paths_answer_from_the_memo(env, monkeypatch) -> None:
    """bind/unbind are called BY the hub. Reaching back into it mid-request would make the hub's own
    call wait on a second hub call, so those paths answer from the memo and never open a client.

    (A refreshing read that fails falls back to the memo too — deliberately, so a hub blip does not
    empty the picker — which is why this counts client construction rather than comparing results.)
    """
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    import flow_sdk.instance_settings.llm_endpoint as settings
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.instance_settings import get_instance_settings

    _login()
    settings._list_cache[get_instance_settings().instance_name] = (
        0.0,  # fetched at the epoch: any TTL has long expired
        [LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="memo")],
    )
    opened: list[int] = []

    async def _no_network(*args, **kwargs):
        # ``hub_get`` swallows its own transport errors and answers ``None``; a stub that
        # raised would be testing a failure mode the real chokepoint cannot produce.
        opened.append(1)
        return None

    # ``hub_get`` is the chokepoint the fetch actually goes through; patching a hand-built
    # client would silently stop counting anything.
    monkeypatch.setattr(hub_http, "hub_get", _no_network)

    assert [e.name for e in await settings.fetch_hub_llm_endpoints(cached_only=True)] == ["memo"]
    assert opened == [], "cached_only must not call out"

    assert [e.name for e in await settings.fetch_hub_llm_endpoints()] == ["memo"], (
        "a failed refresh keeps the last good list rather than emptying the picker"
    )
    assert opened == [1], "a refreshing read really does reach for the hub"


async def test_the_listing_unions_the_catalog_so_the_global_root_is_offered(env, monkeypatch) -> None:
    """The seeded global root holds no role edge for anybody -- it is stamped
    ``authenticated_role: reader`` -- so the ACCESS-SCOPED type listing never returns it and only
    the un-scoped ``catalog`` action does. Reading one listing silently drops the single endpoint
    every signed-in user can always spend.
    """
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

    _login()
    mine = {"id": "11111111-2222-4333-8444-555555555555", "type": "llm_endpoint", "name": "my allocation"}
    globalroot = {"id": "7f1c9d2e-0000-4a00-8000-11e0e0e0e0e0", "type": "llm_endpoint", "name": "global"}
    asked: list[str | None] = []

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        # THE SHAPES ARE NOT THE SAME, and that is the point of this test. Verified against a
        # live hub: the type listing answers an envelope dict, the ``catalog`` ACTION answers a
        # BARE LIST. A stub that returned dicts for both passed while the real union silently
        # dropped every catalog row.
        asked.append(action)
        if action is None:
            return {"data": [mine]}
        return [globalroot, mine]  # the catalog repeats rows the caller has a role on

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    names = [e.name for e in await fetch_hub_llm_endpoints()]

    assert asked == [None, "catalog"], "both listings must be read"
    assert names == ["my allocation", "global"], f"expected the union, de-duplicated; got {names}"


async def test_a_failed_catalog_read_still_offers_the_scoped_rows(env, monkeypatch) -> None:
    """Losing the fallback is not a reason to answer with nothing."""
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

    _login()

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        return (
            None if action == "catalog" else {"data": [{"id": "1" * 8 + "-2222-4333-8444-" + "5" * 12, "name": "mine"}]}
        )

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    assert [e.name for e in await fetch_hub_llm_endpoints()] == ["mine"]


async def test_an_empty_scoped_listing_still_reads_the_catalog(env, monkeypatch) -> None:
    """A hub with nothing allocated to this user answers the type listing with ``{}`` -- no
    ``data`` key at all -- which is SUCCESS with zero rows, not a failure. Reading that as a
    failure returned early and never reached the catalog, so the one endpoint every signed-in
    user can spend went missing precisely when it was the only one they had. Observed on a
    live hub, which is why this shape is pinned.
    """
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints

    _login()
    globalroot = {"id": "7f1c9d2e-0000-4a00-8000-11e0e0e0e0e0", "type": "llm_endpoint", "name": "global"}

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        return {} if action is None else [globalroot]

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    assert [e.name for e in await fetch_hub_llm_endpoints()] == ["global"]


async def test_a_failed_scoped_listing_keeps_the_last_good_list(env, monkeypatch) -> None:
    """``hub_get`` answers ``None`` on failure -- the ONE shape that means "do not trust this"."""
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    import flow_sdk.instance_settings.llm_endpoint as settings
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.instance_settings import get_instance_settings

    _login()
    settings._list_cache[get_instance_settings().instance_name] = (
        0.0,
        [LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="memo")],
    )

    async def _hub_get(entity_type, entity_id=None, action=None, **kwargs):
        return None

    monkeypatch.setattr(hub_http, "hub_get", _hub_get)
    assert [e.name for e in await settings.fetch_hub_llm_endpoints()] == ["memo"]


async def test_a_refresh_drops_a_binding_the_hub_no_longer_lists(env, monkeypatch) -> None:
    """The record itself has to go, not just stop being offered.

    ``box_bound`` is read as "this box was given a budget" -- it demotes an unproven device
    login to the tail of the order -- so a binding left naming a deleted endpoint keeps making
    a claim that is no longer true, and every status answer reports an endpoint that does not
    exist. A refresh is where the box learns otherwise, so it is where the record is dropped.
    """
    import time

    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import hub_llm_endpoint_status
    from flow_sdk.instance_settings import llm_endpoint

    _login()
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:gone", INVOKE_PATH, provider="openrouter", name="Deleted")
    assert llm_endpoint.get_hub_llm_endpoint() is not None
    # A listing that SUCCEEDED and does not mention it.
    llm_endpoint._list_cache[llm_endpoint.get_instance_settings().instance_name] = (time.monotonic(), [])

    status = await hub_llm_endpoint_status()
    assert status["endpoint_typeid"] is None and status["invoke_url"] is None
    assert llm_endpoint.get_hub_llm_endpoint() is None, "the dead binding survived a refresh"


async def test_a_refresh_keeps_a_binding_when_the_hub_could_not_be_reached(env, monkeypatch) -> None:
    """Unreachable is not a verdict. Only a listing that actually answered may drop a binding."""
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import hub_llm_endpoint_status
    from flow_sdk.instance_settings import llm_endpoint

    _login()
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH, provider="openrouter", name="OR")
    llm_endpoint.reset_cache()  # no listing has ever succeeded
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", INVOKE_PATH, provider="openrouter", name="OR")

    status = await hub_llm_endpoint_status()
    assert status["endpoint_typeid"] == "llm_endpoint:ep1"
    assert llm_endpoint.get_hub_llm_endpoint() is not None, "a binding was dropped on no evidence"


async def test_binding_an_endpoint_the_listing_has_not_heard_of_survives_the_bind(env, monkeypatch) -> None:
    """A bind must never undo itself.

    The hub binds a box to an endpoint the listing may not carry yet -- a fresh allocation, a
    share made seconds ago -- and ``bind`` answers through the same status path that drops a
    binding the hub no longer lists. Get that wrong and the push is erased by the very call
    that delivered it, which is the loudest possible way to fail.

    Written against the BEHAVIOUR rather than the guard, because two things currently prevent
    it (the ``refresh`` gate, and the bind-time stamp that makes an older listing unable to
    deny a newer binding) and either one may be simplified away later. The promise is what
    must survive, not the mechanism.
    """
    import time

    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import bind_hub_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint

    _login()
    # A listing that succeeded and knows nothing about what is about to be pushed.
    llm_endpoint._list_cache[llm_endpoint.get_instance_settings().instance_name] = (time.monotonic(), [])

    status = await bind_hub_llm_endpoint(
        {
            "endpoint_typeid": "llm_endpoint:brand-new",
            "invoke_path": INVOKE_PATH,
            "provider": "openrouter",
            "name": "New",
        }
    )
    assert status["endpoint_typeid"] == "llm_endpoint:brand-new", "the bind erased its own binding"
    assert llm_endpoint.get_hub_llm_endpoint() is not None
