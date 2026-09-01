"""Unit tests for the harness API-key auth binding (cli_drivers/api_auth.py).

Isolation matches tests/unit/test_lm_api_keys.py: a temp FLOW_HOME + fresh
instance singleton + SOD_ENC_KEY so the sod store resolves headlessly. These
tests exercise the pure resolver (no worker spawn, no network turn).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "apiauthtest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.fixture(autouse=True)
async def _reset_harness_auth_mode():
    """Reset harness Capabilities back to device auth after each test.

    ``_set_harness_api`` persists ``Capability.auth_mode="api"`` into the shared
    session DB; without this, later unrelated tests that spawn a claude/codex
    worker fail with "set to API-key auth but no key stored" (pass-alone /
    fail-in-batch)."""
    yield
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability

    for worker in ("claude", "codex", "copilot", "opencode"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "auth_mode", "device") != "device":
            cap.auth_mode = "device"
            cap.api_provider = None
            await cap.save(notify=False)
    # And drop any hub LLMEndpoint binding a test left behind.
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()


HUB_INVOKE = "https://hub.test/api/v1/graph/llm_endpoint/ep1/invoke"


def _bind_hub(monkeypatch: pytest.MonkeyPatch, *, login: bool = True) -> None:
    """Put the box in the state the hub leaves it in after login + bind: a hub
    login key in the credential store, ``FLOWPAD_HUB_URL`` pointing at the hub,
    and the ``llm-endpoint`` binding persisted."""
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    if login:
        set_api_key("fp-hub-key")
    llm_endpoint.reset_cache()
    llm_endpoint.set_hub_llm_endpoint(
        "llm_endpoint:ep1", "/api/v1/graph/llm_endpoint/ep1/invoke", provider="openrouter", name="OpenRouter"
    )


def _fake_process(worker_type: str, *, model: str | None = "sm"):
    """A minimal stand-in for AgenticProcess: only .driver.name and .cli_config
    are read by resolve_worker_api_auth."""
    return SimpleNamespace(driver=SimpleNamespace(name=worker_type), cli_config={"model": model})


async def _set_harness_api(kind_worker: str, provider: str = "openrouter") -> None:
    """Put the harness Capability into api mode with the given provider."""
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind(kind_worker))
    assert cap is not None, f"no capability seeded for {kind_worker}"
    cap.auth_mode = "api"
    cap.api_provider = provider
    await cap.save(notify=False)


async def test_device_mode_returns_none(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    # Default capability auth_mode is "device" → no binding.
    assert await resolve_worker_api_auth(_fake_process("claude")) is None


async def test_claude_api_binding(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("claude")

    auth = await resolve_worker_api_auth(_fake_process("claude", model="sm"))
    assert auth is not None
    # Proven-required claude-on-OpenRouter env.
    assert auth.env["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api"
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "sk-or-test"
    assert auth.env["ANTHROPIC_API_KEY"] == ""  # present-but-blank
    assert auth.env["MAX_THINKING_TOKENS"] == "0"
    assert auth.env["DISABLE_INTERLEAVED_THINKING"] == "1"
    assert auth.model_slug == "anthropic/claude-haiku-4.5"
    assert auth.config_overrides == []  # claude uses no -c overrides


async def test_codex_api_binding_has_responses_provider(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("codex")

    auth = await resolve_worker_api_auth(_fake_process("codex", model="sm"))
    assert auth is not None
    assert auth.env["OPENROUTER_API_KEY"] == "sk-or-test"
    assert auth.model_slug == "openai/gpt-5-mini"
    ov = dict(auth.config_overrides)
    assert ov["model_provider"] == "openrouter"
    assert ov["model_providers.openrouter.wire_api"] == "responses"
    assert ov["model_providers.openrouter.base_url"] == "https://openrouter.ai/api/v1"


async def test_copilot_api_binding_model_env(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import (
        apply_api_model_to_options,
        resolve_worker_api_auth,
    )
    from flow_sdk.builtin.agentic_process.cli_drivers.copilot import CopilotAgentOptions
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("copilot")

    process = _fake_process("copilot", model="sm")
    auth = await resolve_worker_api_auth(process)
    assert auth is not None
    assert auth.env["COPILOT_ENABLE_ALT_PROVIDERS"] == "1"
    assert auth.env["COPILOT_PROVIDER_API_KEY"] == "sk-or-test"
    # Model rides three env vars for copilot.
    for var in ("COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_MODEL"):
        assert auth.env[var] == "openai/gpt-5-mini"

    cmd = CopilotAgentOptions(model="sm")
    await apply_api_model_to_options(cmd, process)
    argv, _env = cmd.to_spawn_args()
    assert argv[argv.index("--model") + 1] == "openai/gpt-5-mini"


async def test_api_mode_missing_key_raises(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError

    # api mode selected but NO key stored → loud failure, never a silent fall-through.
    await _set_harness_api("claude")
    with pytest.raises(WorkerSpawnError):
        await resolve_worker_api_auth(_fake_process("claude"))


async def test_raw_slug_passthrough(env) -> None:
    """A concrete model (not an sm/md/lg tier) passes through unchanged."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("claude")
    auth = await resolve_worker_api_auth(_fake_process("claude", model="z-ai/glm-4.6"))
    assert auth.model_slug == "z-ai/glm-4.6"


async def test_api_auth_overrides_append_after_process_hook_overrides(monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers import api_auth

    cmd = SimpleNamespace(
        model=None,
        extra_config_overrides=[("features.hooks", True)],
    )

    async def resolve(_process):
        return api_auth.WorkerApiAuth(
            model_slug="openai/gpt-5-mini",
            config_overrides=[("model_provider", "openrouter")],
        )

    monkeypatch.setattr(api_auth, "resolve_worker_api_auth", resolve)
    await api_auth.apply_api_model_to_options(cmd, SimpleNamespace())

    assert cmd.model == "openai/gpt-5-mini"
    assert cmd.extra_config_overrides == [
        ("features.hooks", True),
        ("model_provider", "openrouter"),
    ]


# ── FlowPad hub endpoint bindings ────────────────────────────────────────────


def test_binding_for_openrouter_is_the_static_spec() -> None:
    """The OpenRouter path is byte-identical to the spec's flat fields."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import (
        CLAUDE_API_AUTH_SPEC,
        CODEX_API_AUTH_SPEC,
        COPILOT_API_AUTH_SPEC,
    )
    from flow_sdk.lm_api import LMApiProvider

    for spec in (CLAUDE_API_AUTH_SPEC, CODEX_API_AUTH_SPEC, COPILOT_API_AUTH_SPEC):
        binding = spec.binding_for(LMApiProvider.OPENROUTER, hub_invoke_url=None)
        assert binding.token_env_var == spec.token_env_var
        assert binding.base_env == spec.base_env
        assert binding.config_overrides == spec.config_overrides
        assert LMApiProvider.FLOWPAD in spec.supported_providers


def test_binding_for_flowpad_requires_an_invoke_url() -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import CLAUDE_API_AUTH_SPEC
    from flow_sdk.lm_api import LMApiProvider

    with pytest.raises(ValueError):
        CLAUDE_API_AUTH_SPEC.binding_for(LMApiProvider.FLOWPAD, hub_invoke_url=None)


async def test_claude_hub_endpoint_binding(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("claude", provider="flowpad")

    auth = await resolve_worker_api_auth(_fake_process("claude", model="sm"))
    assert auth is not None
    # claude appends /v1/messages itself; the base is the endpoint's invoke URL.
    assert auth.env["ANTHROPIC_BASE_URL"] == HUB_INVOKE
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"  # the hub LOGIN key, not an lm_api secret
    assert auth.env["ANTHROPIC_API_KEY"] == ""
    assert auth.env["MAX_THINKING_TOKENS"] == "0"
    assert auth.env["DISABLE_INTERLEAVED_THINKING"] == "1"
    assert auth.model_slug == "anthropic/claude-haiku-4.5"  # OpenRouter slugs: the endpoint is a passthrough
    assert auth.config_overrides == []


async def test_codex_hub_endpoint_binding(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("codex", provider="flowpad")

    auth = await resolve_worker_api_auth(_fake_process("codex", model="sm"))
    assert auth is not None
    assert auth.env["FLOWPAD_HUB_API_KEY"] == "fp-hub-key"
    assert "OPENROUTER_API_KEY" not in auth.env
    ov = dict(auth.config_overrides)
    assert ov["model_provider"] == "flowpad"
    assert ov["model_providers.flowpad.base_url"] == f"{HUB_INVOKE}/v1"
    assert ov["model_providers.flowpad.wire_api"] == "responses"
    assert ov["model_reasoning_effort"] == "low"  # gpt-5 via OpenRouter refuses reasoning=none
    assert ov["model_providers.flowpad.env_key"] == "FLOWPAD_HUB_API_KEY"
    assert auth.model_slug == "openai/gpt-5-mini"


async def test_copilot_hub_endpoint_binding(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("copilot", provider="flowpad")

    auth = await resolve_worker_api_auth(_fake_process("copilot", model="sm"))
    assert auth is not None
    assert auth.env["COPILOT_ENABLE_ALT_PROVIDERS"] == "1"
    assert auth.env["COPILOT_PROVIDER_TYPE"] == "openai"
    assert auth.env["COPILOT_PROVIDER_BASE_URL"] == f"{HUB_INVOKE}/v1"
    assert auth.env["COPILOT_PROVIDER_API_KEY"] == "fp-hub-key"
    for var in ("COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL", "COPILOT_MODEL"):
        assert auth.env[var] == "openai/gpt-5-mini"


async def test_hub_endpoint_unbound_raises(env, monkeypatch) -> None:
    """api/flowpad with no binding: loud failure, never a fall-through to device."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.cli.auth.hub_login import set_api_key

    set_api_key("fp-hub-key")
    await _set_harness_api("claude", provider="flowpad")
    with pytest.raises(WorkerSpawnError):
        await resolve_worker_api_auth(_fake_process("claude"))


async def test_hub_endpoint_without_login_raises(env, monkeypatch) -> None:
    """Bound but logged out: the "key" is the hub login, so there is none."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.cli.auth.hub_login import delete_api_key

    _bind_hub(monkeypatch, login=False)
    delete_api_key()
    await _set_harness_api("claude", provider="flowpad")
    with pytest.raises(WorkerSpawnError):
        await resolve_worker_api_auth(_fake_process("claude"))


# ── a process may spend a different budget than its box ──────────────────────

#: A real typeid: the override is validated as one, so a non-uuid id is not an endpoint.
EP2 = "llm_endpoint-22222222-2222-4333-8444-555555555555"
OTHER_INVOKE = "https://hub.test/api/v1/graph/llm_endpoint/22222222-2222-4333-8444-555555555555/invoke"


def _process_on(worker_type: str, typeid: str | None, *, model: str | None = "sm"):
    """``_fake_process`` plus the per-process endpoint override."""
    process = _fake_process(worker_type, model=model)
    process.llm_endpoint_typeid = typeid
    return process


async def test_a_process_endpoint_overrides_the_box_binding(env, monkeypatch) -> None:
    """The box binding is a default, not a ceiling: a process that names an endpoint spends that one.

    Which is the whole point -- one box may hold several usable budgets (its own allocation plus
    anything shared with the user), and two processes on it may legitimately spend different ones.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("claude", provider="flowpad")

    auth = await resolve_worker_api_auth(_process_on("claude", EP2))
    assert auth is not None
    assert auth.env["ANTHROPIC_BASE_URL"] == OTHER_INVOKE
    # Still the hub LOGIN key: the endpoint changes WHICH budget is spent, never how the box signs.
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"


async def test_a_process_without_an_endpoint_uses_the_box_binding(env, monkeypatch) -> None:
    """Unset must mean exactly today's behaviour -- agent deploys have no UI to choose with."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("claude", provider="flowpad")

    auth = await resolve_worker_api_auth(_process_on("claude", None))
    assert auth is not None and auth.env["ANTHROPIC_BASE_URL"] == HUB_INVOKE


async def test_a_process_endpoint_resolves_with_no_box_binding(env, monkeypatch) -> None:
    """Logged in but never bound: the process names the budget, so there is one to point at.

    The FlowPad "key" is the hub login, and what made it usable used to be the pushed binding alone.
    A process override is the other way to have an endpoint, and it has to count.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    set_api_key("fp-hub-key")
    assert llm_endpoint.get_hub_llm_endpoint() is None, "this test is about the UNBOUND box"
    await _set_harness_api("claude", provider="flowpad")

    auth = await resolve_worker_api_auth(_process_on("claude", EP2))
    assert auth is not None and auth.env["ANTHROPIC_BASE_URL"] == OTHER_INVOKE


@pytest.mark.parametrize(
    "bad", ["not-a-typeid", "", "llm_endpoint-ep2", "project-11111111-2222-4333-8444-555555555555"]
)
async def test_an_unusable_process_endpoint_falls_back_to_the_binding(env, monkeypatch, bad) -> None:
    """Garbage, a non-uuid id, and a well-formed typeid of the WRONG type all fall back rather than
    building a plausible-looking invoke URL for something that is not a budget."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("claude", provider="flowpad")

    auth = await resolve_worker_api_auth(_process_on("claude", bad))
    assert auth is not None and auth.env["ANTHROPIC_BASE_URL"] == HUB_INVOKE


async def test_a_named_endpoint_is_enough_on_a_device_mode_harness(env, monkeypatch) -> None:
    """``set_llm_endpoint`` has to be a whole interface, not half of one.

    A harness left on its vendor device login is the ordinary case. If naming an endpoint only took
    effect once someone also flipped the Capability into api mode, the setter would appear to work
    and then be silently ignored — and flipping the Capability to compensate would change which
    budget every OTHER process on this box spends. Per-process is the point.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    _bind_hub(monkeypatch)
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    assert cap is not None and getattr(cap, "auth_mode", "device") == "device", "start from device login"

    auth = await resolve_worker_api_auth(_process_on("claude", EP2))
    assert auth is not None, "a process that names a budget must spend it"
    assert auth.env["ANTHROPIC_BASE_URL"] == OTHER_INVOKE
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"


async def test_a_bound_box_funds_an_unproven_device_harness_from_its_endpoint(env, monkeypatch) -> None:
    """A bound box, a harness nobody has signed in: the endpoint funds the spawn.

    This used to answer ``None`` (device login), and could only be reached artificially:
    binding ALSO rewrote every harness to ``(api, flowpad)``, so "bound box + device mode"
    did not occur in the wild. Binding no longer writes to ``Capability``, which makes this
    exact state the ordinary one for a fresh sandbox -- claude installed, never logged in,
    an endpoint pushed after login. Answering "device login" there would hand the turn to a
    vendor sign-in picker and hang it.

    ``login_state`` is ``Persist.FALSE``, so "nobody has asked" is the common state, not an
    edge case; the box binding is the deliberate act that breaks the tie. See
    ``test_an_unbound_box_still_prefers_the_device_login`` for the other half -- the desktop
    default is unchanged.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    auth = await resolve_worker_api_auth(_process_on("claude", None))
    assert auth is not None
    assert auth.env["ANTHROPIC_BASE_URL"] == HUB_INVOKE
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"


async def test_an_unbound_box_still_prefers_the_device_login(env) -> None:
    """No binding, no keys, nobody probed: device login, exactly as before.

    The state most desktop installs are in. ``resolve_llm_source`` falls through to its
    second pass (*first eligible*, not *first eligible AND auto*) precisely so an unproven
    device login stays usable when nothing else is configured.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    assert await resolve_worker_api_auth(_process_on("claude", None)) is None


async def test_opencode_reaches_the_endpoint_through_its_config_not_its_env(env, monkeypatch) -> None:
    """opencode is the one harness that cannot be redirected with environment variables.

    Its OpenRouter provider is built in and honours no base-URL variable -- verified against 1.18.25,
    where ``OPENROUTER_BASE_URL`` is ignored and the CLI still calls openrouter.ai. So its binding
    carries a ``provider`` fragment for the generated ``opencode.json`` instead, and the key keeps
    riding the environment exactly as it did.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    auth = await resolve_worker_api_auth(_process_on("opencode", EP2))

    assert auth is not None, "opencode must be able to spend a named endpoint like every other harness"
    assert auth.env["OPENROUTER_API_KEY"] == "fp-hub-key"
    assert auth.provider_options == {"openrouter": {"options": {"baseURL": f"{OTHER_INVOKE}/v1"}}}
    assert not any("BASE_URL" in name for name in auth.env), (
        "opencode reads no base-URL variable; putting one in env would look like it worked"
    )
