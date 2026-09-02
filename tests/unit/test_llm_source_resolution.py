"""Which ``LLMSource`` funds a spawn — the ladder, the eligibility rules, and the
promise that resolving costs no network call.

The spawn binding itself (env vars, model slugs, codex ``-c`` overrides) is
``test_api_auth_binding.py``'s subject. This file is only about *which source wins and
why*, because that is the part every surface now shares: the picker renders the same
list the resolver picks from, and a spawn failure is a rendering of it.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import DeviceLoginState


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "llmsourcetest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.fixture(autouse=True)
async def _clean(env):
    """Leave no binding and no api-mode harness behind: both persist into the shared
    session DB and would otherwise make later tests fail only in batch."""
    yield
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.instance_settings import llm_endpoint

    for worker in ("claude", "codex", "copilot", "opencode"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "auth_mode", "device") != "device":
            cap.auth_mode = "device"
            cap.api_provider = None
            await cap.save(notify=False)
    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()


EP1 = "llm_endpoint-11111111-2222-4333-8444-555555555555"
EP2 = "llm_endpoint-22222222-2222-4333-8444-555555555555"


def _bind(monkeypatch, *, login: bool = True, typeid: str = EP1) -> None:
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    if login:
        set_api_key("fp-hub-key")
    llm_endpoint.reset_cache()
    llm_endpoint.set_hub_llm_endpoint(typeid, f"/api/v1/graph/{typeid}/invoke", provider="openrouter", name="Team pool")


def _process(worker_type: str = "claude", *, endpoint: str | None = None, project_id: str | None = None):
    return SimpleNamespace(
        driver=SimpleNamespace(name=worker_type),
        cli_config={"model": "sm"},
        llm_endpoint_typeid=endpoint,
        project_id=project_id,
        typeid=f"agentic_process-{'0' * 8}-2222-4333-8444-555555555555",
    )


def _by_kind(candidates, kind):
    """The verdicts whose endpoint is of *kind*.

    The kind lives on the endpoint now, not on the verdict — a verdict names an endpoint
    and says nothing about what sort of thing it is.
    """
    return [c.source for c in candidates if str(c.endpoint.kind) == kind]


# ── the device rung, as a pure function ──────────────────────────────────────────


#: The REAL type ``Capability.login_state`` holds. Passing bare strings here is what let a
#: ``str(enum)`` bug through: ``DeviceLoginState`` is ``(str, Enum)``, not ``StrEnum``, so
#: ``str()`` on a member gives its repr and every comparison silently fell through.
_AUTH = DeviceLoginState.AUTHENTICATED
_IDLE = DeviceLoginState.IDLE
_ERROR = DeviceLoginState.ERROR


@pytest.mark.parametrize(
    ("state", "bound", "eligible", "auto"),
    [
        (_AUTH, False, True, True),
        (_AUTH, True, True, True),  # proven beats a mere offer
        (_IDLE, False, False, False),  # a probe SAID so
        (_IDLE, True, False, False),
        (_ERROR, True, False, False),
        (None, False, True, True),  # nobody asked: today's desktop default
        (None, True, True, False),  # nobody asked, but this box was given an endpoint
        # the string forms too -- the field is ``(str, Enum)``, so both reach this code
        ("authenticated", False, True, True),
        ("idle", False, False, False),
    ],
)
def test_the_device_rung_only_asserts_what_it_was_told(state, bound, eligible, auto) -> None:
    """``login_state`` is ``Persist.FALSE``, so ``None`` means "nobody has asked" -- the
    COMMON state after any restart, not an edge case. We rule a device login out only on a
    verdict we were actually given, and let an explicit box binding break the tie when we
    have none."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _device_source

    source = _device_source("claude", state, bound).source
    assert (source.eligible, source.auto) == (eligible, auto)
    # a verdict we were GIVEN is cached evidence; no verdict is only a presumption
    assert str(source.authority) == ("presumed" if state is None else "cached")
    if not source.eligible:
        assert source.reason, "an ineligible source must always say why"
    else:
        assert not source.reason, "an eligible source must not carry a caveat as its reason"


def test_the_device_rung_says_nothing_about_being_installed() -> None:
    """Presence is ``build_worker_spawn_env``'s question, and it answers it better."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _device_source

    assert _device_source("claude", None, False).source.eligible


# ── the default order ────────────────────────────────────────────────────────────


async def test_nothing_configured_falls_back_to_the_device_login(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint

    assert str((await resolve_llm_endpoint(_process())).endpoint.kind) == "device"


async def test_a_stored_key_does_not_outrank_an_unprobed_device_login(env) -> None:
    """Ascending marginal cost: a subscription already paid for beats spending money."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    assert str((await resolve_llm_endpoint(_process())).endpoint.kind) == "device"


async def test_a_bound_box_funds_an_unprobed_harness_from_its_endpoint(env, monkeypatch) -> None:
    """The sandbox case: claude installed, never signed in, an endpoint pushed after login."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint

    _bind(monkeypatch)
    endpoint, chosen = await resolve_llm_endpoint(_process())
    assert str(endpoint.kind) == "hub" and chosen.endpoint_typeid == EP1


async def test_a_signed_out_device_login_is_ruled_out_with_a_reason(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _device_source

    listed = await list_llm_candidates("claude")
    assert _by_kind(listed, "device"), "the device rung is always listed, eligible or not"
    out = _device_source("claude", "idle", False).source
    assert not out.eligible and "signed out" in out.reason


# ── constraints ──────────────────────────────────────────────────────────────────


async def test_a_process_endpoint_rules_every_other_source_out_with_a_reason(env, monkeypatch) -> None:
    """A constraint is rendered ONTO the list, so the picker's greyed rows and the spawn
    error are the same data and cannot disagree."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_sources, resolve_llm_endpoint
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    _bind(monkeypatch)
    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    process = _process(endpoint=EP2)

    endpoint, chosen = await resolve_llm_endpoint(process)
    assert str(endpoint.kind) == "hub" and chosen.endpoint_typeid == EP2
    assert str(chosen.origin) == "process"

    listed = await list_llm_sources("claude", process)
    others = [s for s in listed if s.endpoint_typeid != EP2]
    assert others, "the alternatives are still listed -- ruled out, not hidden"
    assert all(not s.eligible for s in others)
    assert all("this process requires" in s.reason for s in others)


async def test_a_project_endpoint_constrains_every_process_in_it(env, monkeypatch) -> None:
    """The project rung. A process that names its own endpoint still wins over it -- most
    specific first -- which is what keeps the override per-process rather than a way to
    change what every other process on the box spends."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates, resolve_llm_source
    from flow_sdk.builtin.project import Project

    _bind(monkeypatch)
    project = await Project(name="constrained", llm_endpoint_typeid=EP2).save()

    chosen = await resolve_llm_source(_process(project_id=project.id))
    assert chosen.endpoint_typeid == EP2 and str(chosen.origin) == "project"

    device = _by_kind(await list_llm_candidates("claude", _process(project_id=project.id)), "device")[0]
    assert not device.eligible and "this project requires" in device.reason

    # a process naming its own endpoint outranks the project's
    own = await resolve_llm_source(_process(endpoint=EP1, project_id=project.id))
    assert own.endpoint_typeid == EP1 and str(own.origin) == "process"


async def test_a_process_without_a_project_is_not_constrained(env) -> None:
    """``project_id`` is legitimately ``None`` for embedded and inline processes; a missing
    project contributes no constraint rather than failing closed."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint

    assert str((await resolve_llm_endpoint(_process(project_id=None))).endpoint.kind) == "device"


async def test_an_endpoint_nobody_has_heard_of_still_resolves(env, monkeypatch) -> None:
    """Not in the local list is not a refusal: the hub authorizes every invoke against the
    endpoint in the URL, so a typeid we do not know can only earn a 401/403 -- and a
    freshly shared endpoint must work before any cache has heard of it."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_source

    _bind(monkeypatch)
    chosen = await resolve_llm_source(_process(endpoint=EP2))
    assert chosen.endpoint_typeid == EP2


# ── an explicit preference is a constraint, not a hint ───────────────────────────


async def test_an_explicit_preference_wins_and_rules_the_rest_out(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates, resolve_llm_endpoint
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    cap.auth_mode, cap.api_provider = "api", "openrouter"
    await cap.save(notify=False)

    endpoint, chosen = await resolve_llm_endpoint(_process())
    assert str(endpoint.kind) == "api_key" and endpoint.provider == "openrouter"
    assert str(chosen.origin) == "user"

    device = _by_kind(await list_llm_candidates("claude"), "device")[0]
    assert not device.eligible and "set to use openrouter" in device.reason


async def test_an_unavailable_preference_fails_loudly_rather_than_spending_something_else(env) -> None:
    """Never a silent fall-through: substituting another source would spend a subscription
    or a budget the caller did not choose."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import LLMSourceError, resolve_llm_source
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    cap.auth_mode, cap.api_provider = "api", "openrouter"
    await cap.save(notify=False)

    with pytest.raises(LLMSourceError) as excinfo:
        await resolve_llm_source(_process())
    assert "no openrouter key" in str(excinfo.value), "the failure is a rendering of the list"


# ── the promise that makes this safe to call at spawn ────────────────────────────


async def test_resolution_makes_no_network_call(env, monkeypatch) -> None:
    """A spawn must never wait on the hub to find out what may fund it."""
    import flow_sdk.cloud_client.transport.hub_http as hub_http
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_source

    _bind(monkeypatch)
    calls: list[str] = []

    async def _no_network(*args, **kwargs):
        calls.append("hub")
        return None

    monkeypatch.setattr(hub_http, "hub_get", _no_network)
    await resolve_llm_source(_process())
    assert calls == [], "resolution reached for the hub"


# ── the tier tables ──────────────────────────────────────────────────────────────


def test_no_harness_collapses_its_model_tiers() -> None:
    """sm/md/lg must name three different models on the key and endpoint paths.

    codex, copilot and opencode each mapped ``md`` and ``lg`` to the SAME slug, so asking
    for the accurate model quietly got the balanced one -- a tier that silently does
    nothing is worse than one that does not exist, because the caller believes it worked.
    The device-login path has always had three distinct tiers; this keeps the funded paths
    honest about the same promise.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS

    for worker, spec in _SPECS.items():
        slugs = [spec.tier_models[t] for t in ("sm", "md", "lg")]
        assert len(set(slugs)) == 3, f"{worker} maps two tiers to one model: {spec.tier_models}"


def test_every_harness_declares_all_three_tiers() -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _SPECS

    for worker, spec in _SPECS.items():
        assert set(spec.tier_models) >= {"sm", "md", "lg"}, worker
