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
        if cap is None:
            continue
        dirty = False
        if getattr(cap, "auth_mode", "device") != "device":
            cap.auth_mode = "device"
            cap.api_provider = None
            dirty = True
        # The sweep now RESOLVES login_state (discovery._resolve_login_states), and the suite
        # sandboxes HOME -- so a real probe here honestly answers "signed out" and persists
        # that into the shared session DB. Left behind, every later test that assumes a usable
        # device login fails only in batch. Same rule as auth_mode above: runtime state this
        # file causes, this file clears.
        if getattr(cap, "login_state", None) is not None:
            cap.login_state = None
            cap.login_message = None
            dirty = True
        if dirty:
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
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _device_source, list_llm_candidates

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


# ── the device rung's verdict has to actually be resolved ────────────────────────


@pytest.mark.long  # 2.14s -- runs the real sweep, which spawns the env-probe subprocess
async def test_the_startup_sweep_resolves_the_device_rungs_login_state(env) -> None:
    """The startup sweep must leave ``login_state`` holding a VERDICT, not ``None``.

    ``None`` is the whole ladder's blind spot. ``_device_source`` reads it as "nobody has
    asked" and therefore keeps the device rung eligible at ``_RANK_DEVICE`` -- correct, and
    tested above -- so on an unbound box ``pick_llm_candidate`` returns device on its first
    pass and never descends to the hub endpoint at ``_RANK_ENDPOINT``. ``resolve_worker_api_auth``
    then returns ``None`` for a DEVICE source (api_auth.py:328) and the spawn is handed no
    credentials at all: no ``ANTHROPIC_BASE_URL``, and the turn dies on the vendor's own
    "Could not resolve authentication method".

    The rung's rule is fine. What is missing is the answer it is waiting for: the sweep runs
    ``runner.discover()`` (a PRESENCE probe -- where is the binary) and mirrors that to the
    row, but never runs ``driver.auth_probe()``, so ``_mirror_probe_to_login_state`` is never
    reached and ``login_state`` -- ``Persist.FALSE``, hence ``None`` after every restart --
    stays ``None`` for the life of the process.

    Either verdict passes this test. LOGGED_IN and LOGGED_OUT are both answers; only silence
    is the bug.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.capabilities import discovery
    from flow_sdk.core.capabilities.discovery import ensure_discovered, get_capability_value
    from flow_sdk.core.capabilities.models import CapabilityKind

    discovery._DISCOVERED_ONCE.clear()  # a sweep may already have run in this session
    assert await ensure_discovered(), "the startup sweep did not complete"

    installed = get_capability_value(CapabilityKind.CLAUDE_CLI.value)
    if installed is None or installed.value is None:
        pytest.skip("claude CLI is not installed on this machine; the probe has nothing to ask")

    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    assert cap is not None, "the harness row exists once discovery has swept"
    assert cap.login_state is not None, (
        "the sweep left login_state=None, so the device rung stays eligible on presumption; "
        "an unbound box then funds the spawn from a device login nobody verified"
    )


# ── a binding the hub no longer honours ──────────────────────────────────────────


async def test_a_bound_endpoint_a_successful_listing_denies_is_not_offered(env, monkeypatch) -> None:
    """A deleted (or un-shared) endpoint must stop being a candidate once we can SEE that.

    The box keeps spending whatever the hub last pushed, and nothing tells it when that endpoint
    is deleted -- so the binding outlives the row. Because a bound endpoint outranks an unproven
    device login, every spawn then posted to an invoke URL answering ``Entity ... not found``
    and the harness burned its whole retry budget on it. Observed three times in one day on
    prod, and the box never fell back to anything.

    The signal that separates "gone" from "the cache has not caught up" is whether a listing has
    ever SUCCEEDED: ``_list_cache`` is written only on a successful read, so an entry means the
    hub has answered and its answer did not include this endpoint.
    """
    import time

    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates, resolve_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint as settings

    _bind(monkeypatch)  # box bound to EP1
    # A listing that SUCCEEDED and does not mention EP1 -- what the hub answers once EP1 is gone.
    settings._list_cache[settings.get_instance_settings().instance_name] = (time.monotonic(), [])
    assert settings.listing_supersedes_binding()

    assert not _by_kind(await list_llm_candidates("claude"), "hub"), (
        "the deleted endpoint is still being offered as a source"
    )
    # ...and the ladder falls through to what the box can actually spend.
    assert str((await resolve_llm_endpoint(_process())).endpoint.kind) == "device"


async def test_a_bound_endpoint_is_still_trusted_before_any_listing_succeeds(env, monkeypatch) -> None:
    """The other half, and the reason the rule is keyed on the listing rather than on absence:
    a freshly bound or freshly shared endpoint has to work before any cache has heard of it."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint as settings

    _bind(monkeypatch)
    settings.reset_cache()  # nobody has managed to ask yet
    assert not settings.listing_supersedes_binding()

    endpoint, chosen = await resolve_llm_endpoint(_process())
    assert str(endpoint.kind) == "hub" and chosen.endpoint_typeid == EP1


async def test_a_stale_listing_does_not_deny_a_freshly_pushed_binding(env, monkeypatch) -> None:
    """The push is allowed to run ahead of the cache, and this is where that survives.

    ``_inventory`` reads the listing ``cached_only``, and the hub binds a box to an endpoint the
    listing may not have heard of yet -- so "a listing has succeeded at some point" is NOT
    evidence against a binding written after it. Keying on "has one ever succeeded" broke the
    sandbox flow: bind, then spawn, and the endpoint the hub had just pushed was refused.
    """

    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import resolve_llm_endpoint
    from flow_sdk.instance_settings import llm_endpoint as settings

    _bind(monkeypatch)  # the hub pushes an endpoint (``_bind`` resets the memo, as a real bind does)
    # ...and the only listing we hold succeeded BEFORE that push, and never mentioned it.
    # Seeded AFTER the bind and stamped earlier on purpose: seeding it first would be wiped by
    # ``_bind``'s own ``reset_cache`` and the test would pass on the empty-cache branch instead,
    # proving nothing about ordering.
    name = settings.get_instance_settings().instance_name
    settings._list_cache[name] = (settings._bound_at[name] - 1.0, [])

    assert not settings.listing_supersedes_binding(), "a listing older than the binding cannot deny it"
    endpoint, chosen = await resolve_llm_endpoint(_process())
    assert str(endpoint.kind) == "hub" and chosen.endpoint_typeid == EP1


async def test_a_process_constraint_on_a_vanished_endpoint_still_fails_loudly(env, monkeypatch) -> None:
    """Dropping a DEFAULT binding must not soften an EXPLICIT one.

    The default order is soft -- that is what lets a deleted endpoint fall through to whatever
    the box can actually spend. A named endpoint is a constraint, and the whole point of a
    constraint is that it is not silently substituted: quietly falling back would spend a
    personal subscription the caller did not choose, which is worse than failing.

    ``_apply_constraint`` is a separate path from ``_endpoint_sources`` and still stubs the
    named typeid, so the listing's silence cannot turn a hard rung into a soft one.
    """
    import time

    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates, resolve_llm_source
    from flow_sdk.instance_settings import llm_endpoint as settings

    _bind(monkeypatch)
    settings._list_cache[settings.get_instance_settings().instance_name] = (time.monotonic(), [])
    assert settings.listing_supersedes_binding()

    chosen = await resolve_llm_source(_process(endpoint=EP2))
    assert chosen.endpoint_typeid == EP2, "a named endpoint was substituted after the listing dropped it"
    device = _by_kind(await list_llm_candidates("claude", _process(endpoint=EP2)), "device")[0]
    assert not device.eligible and "this process requires" in device.reason


async def test_an_explicit_hub_preference_fails_rather_than_spending_the_subscription(env, monkeypatch) -> None:
    """The user picked "the hub endpoint" in LLM Sources. If it is gone, say so.

    This is the case that would be worst to get wrong: silently resolving to the device login
    means the turn succeeds and quietly bills a personal Claude subscription instead of the
    budget the user chose.
    """
    import time

    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import LLMSourceError, resolve_llm_source
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.instance_settings import llm_endpoint as settings

    _bind(monkeypatch)
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    cap.auth_mode, cap.api_provider = "api", "flowpad"
    await cap.save(notify=False)
    settings._list_cache[settings.get_instance_settings().instance_name] = (time.monotonic(), [])

    with pytest.raises(LLMSourceError):
        await resolve_llm_source(_process())
