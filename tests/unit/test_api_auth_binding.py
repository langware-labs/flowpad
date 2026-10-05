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

from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import FUNDED_MAX_OUTPUT_TOKENS
from tests.utils.harness_installed import harness_installed  # noqa: F401 — a fixture

# CI has no vendor CLI on PATH; a turn needs one installed (tests/utils/harness_installed.py).
pytestmark = pytest.mark.usefixtures("harness_installed")


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

    for worker in ("claude", "codex", "copilot", "opencode", "deepagents"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is None:
            continue
        if getattr(cap, "auth_mode", "device") != "device" or getattr(cap, "login_state", None) is not None:
            # ``_signed_in`` persists a login into the shared session DB too; left behind it
            # turns "nobody has checked" tests into "signed in" ones, only in batch.
            cap.auth_mode = "device"
            cap.api_provider = None
            cap.login_state = None
            await cap.save(notify=False)
    # And drop any hub LLMEndpoint binding a test left behind.
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()


@pytest.fixture(autouse=True)
def _status_facts(monkeypatch):
    """The STATUS facts funding reads, made deterministic (see test_llm_source_resolution):
    every CLI installed, a hub budget spendable exactly when a hub key is stored (the real rule,
    not faked), no spawn probe."""
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source
    from flow_sdk.core import status
    from flow_sdk.core.status import InstallState

    monkeypatch.setattr(status, "harness_install", lambda worker: InstallState.INSTALLED)

    async def no_probe(worker_type):
        return None

    monkeypatch.setattr(llm_source, "check_unchecked_login", no_probe)


async def _signed_in(*workers: str) -> None:
    """A device login a probe CONFIRMED -- the only kind that funds a turn."""
    from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import DeviceLoginState
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    for worker in workers:
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        cap.login_state = DeviceLoginState.AUTHENTICATED
        await cap.save(notify=False)


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

    # Default capability auth_mode is "device" → no binding: the CLI reads its own login.
    await _signed_in("claude")
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
    assert auth.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == str(FUNDED_MAX_OUTPUT_TOKENS)
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


async def test_hub_endpoint_without_login_falls_through(env, monkeypatch) -> None:
    """Bound but SIGNED OUT of Flowpad: the preference is ignored, not enforced.

    A Flowpad budget is a preference, and a preference names a source the person
    would rather spend -- it cannot name one they can still reach once they have
    signed out. Enforcing it here is the trap that was reported on Windows:
    claude installed AND signed in, and every launch refused with

        claude has no usable LLM source:
          - claude device login: claude is set to use flowpad
          - openrouter key:      claude is set to use flowpad

    -- two working sources excluded by a budget the box could no longer reach.
    So a signed-out box drops the pin and walks the ordinary ladder (device
    login first, then a stored key). Here that lands on the device login, and
    device auth is ``None`` -- the vendor CLI reads its own credentials.

    The narrowing is exactly this one case. ``test_hub_endpoint_unbound_raises``
    is its sibling and still fails loudly: SIGNED IN with no endpoint bound is a
    broken binding, not an unreachable one.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.cli.auth.hub_login import delete_api_key

    await _signed_in("claude")
    _bind_hub(monkeypatch, login=False)
    delete_api_key()
    await _set_harness_api("claude", provider="flowpad")
    assert await resolve_worker_api_auth(_fake_process("claude")) is None


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
    ``test_an_unbound_box_with_an_unchecked_login_is_refused_not_presumed`` for the other half -- the desktop
    default is unchanged.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    auth = await resolve_worker_api_auth(_process_on("claude", None))
    assert auth is not None
    assert auth.env["ANTHROPIC_BASE_URL"] == HUB_INVOKE
    assert auth.env["ANTHROPIC_AUTH_TOKEN"] == "fp-hub-key"


async def test_an_unbound_box_with_an_unchecked_login_is_refused_not_presumed(env) -> None:
    """No binding, no keys, login never probed: refused with a reason.

    This used to presume the unproven device login worked -- the same rule that made every
    absent vendor CLI "the active funding source" on a box with nothing installed. A spawn
    probes an unchecked login before resolving (``check_unchecked_login``, off in this
    suite), so a real box pays one probe, not a failed turn.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError

    with pytest.raises(WorkerSpawnError, match="sign-in has not been checked"):
        await resolve_worker_api_auth(_process_on("claude", None))


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


# ── deepagents: OUR runner, the chat-completions wire, and no account of its own ──


async def test_deepagents_api_binding(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("deepagents")

    auth = await resolve_worker_api_auth(_fake_process("deepagents", model="lg"))
    assert auth is not None
    # Both are read by the runner's model factory; nothing is written to disk.
    assert auth.env["FLOWPAD_DEEPAGENTS_BASE_URL"] == "https://openrouter.ai/api/v1"
    assert auth.env["FLOWPAD_DEEPAGENTS_API_KEY"] == "sk-or-test"
    assert auth.model_slug == "z-ai/glm-5.3"  # a bare gateway slug — no opencode-style provider prefix
    assert auth.config_overrides == []


async def test_deepagents_hub_endpoint_binding(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api("deepagents", provider="flowpad")

    auth = await resolve_worker_api_auth(_fake_process("deepagents", model="sm"))
    assert auth is not None
    assert auth.env["FLOWPAD_DEEPAGENTS_BASE_URL"] == f"{HUB_INVOKE}/v1"
    assert auth.env["FLOWPAD_DEEPAGENTS_API_KEY"] == "fp-hub-key"
    assert auth.env["FLOWPAD_DEEPAGENTS_MAX_OUTPUT_TOKENS"] == str(FUNDED_MAX_OUTPUT_TOKENS)
    assert auth.model_slug == "z-ai/glm-5.3-flash"


@pytest.mark.parametrize(
    ("worker", "var"),
    [
        ("claude", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
        ("opencode", "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
        ("deepagents", "FLOWPAD_DEEPAGENTS_MAX_OUTPUT_TOKENS"),
    ],
)
async def test_a_funded_spawn_caps_its_replies_where_the_harness_takes_a_cap(env, monkeypatch, worker, var) -> None:
    """Uncapped, a harness asks for 32000 (claude, opencode) or the model's maximum (deepagents):
    a hub ceiling refuses the first, an OpenRouter daily limit the second."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    _bind_hub(monkeypatch)
    await _set_harness_api(worker, provider="flowpad")
    auth = await resolve_worker_api_auth(_fake_process(worker, model="sm"))
    assert auth is not None and auth.env[var] == str(FUNDED_MAX_OUTPUT_TOKENS)


def test_the_deepagents_model_sends_the_cap_its_binding_set(monkeypatch) -> None:
    """The runner's model carries the binding's reply cap -- and sends none when unset."""
    from flow_sdk.builtin.agentic_process.cli_drivers.deepagents import models, runner

    monkeypatch.setenv(runner.BASE_URL_ENV, "http://hub/v1")
    monkeypatch.setenv(runner.API_KEY_ENV, "k")
    monkeypatch.setenv(runner.MAX_OUTPUT_ENV, "16384")
    assert models.openai_wire_model("z-ai/glm-5").max_tokens == 16384
    monkeypatch.delenv(runner.MAX_OUTPUT_ENV)
    assert models.openai_wire_model("z-ai/glm-5").max_tokens is None


def _hub_candidate(key: str, name: str, models_allow: list[str]):
    """A hub endpoint narrowed to *models_allow*, already chosen to fund the spawn."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import Candidate
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMFilters
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSource, LLMSourceAuthority

    set_api_key("fp-hub-key")
    endpoint = LLMEndpoint.projection("hub", key, name=name, provider="openrouter")
    endpoint.filters = LLMFilters(models_allow=models_allow)
    source = LLMSource(
        endpoint_typeid=str(endpoint.typeid),
        name=endpoint.name,
        rank=0,
        eligible=True,
        auto=True,
        authority=LLMSourceAuthority.CACHED,
    )
    return Candidate(endpoint, source)


async def test_deepagents_falls_back_to_a_models_allow_slug(env) -> None:
    """A hub endpoint's ``filters.models_allow`` can rule out the tier's default slug — a team
    scoped to one Anthropic model while deepagents' ``sm`` tier names a z-ai one. The binding
    must fall back to a model that endpoint actually permits, rather than hand the worker a
    slug the endpoint is guaranteed to refuse at call time ("model not allowed by endpoint")."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate

    candidate = _hub_candidate("course-ep", "AI Course budget", ["anthropic/claude-haiku-4.5"])

    auth = await binding_for_candidate("deepagents", candidate, tier="sm")
    assert auth is not None
    assert auth.model_slug == "anthropic/claude-haiku-4.5"


async def test_deepagents_keeps_its_tier_slug_when_a_wildcard_allows_it(env) -> None:
    """A glob allow-pattern that already covers the tier's default must not trigger the
    fallback — only a slug the endpoint actually refuses should be swapped out."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate

    candidate = _hub_candidate("wide-ep", "wide budget", ["z-ai/*"])

    auth = await binding_for_candidate("deepagents", candidate, tier="sm")
    assert auth is not None
    assert auth.model_slug == "z-ai/glm-5.3-flash"


def test_model_within_allowance_pure() -> None:
    """The matcher itself: no restriction, a matching glob, and a ruled-out slug that falls
    back to the first literal (non-glob) entry — the three cases the binding above relies on."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _model_within_allowance

    assert _model_within_allowance("z-ai/glm-5.3-flash", []) == "z-ai/glm-5.3-flash"
    assert _model_within_allowance("z-ai/glm-5.3-flash", ["z-ai/*"]) == "z-ai/glm-5.3-flash"
    assert _model_within_allowance("z-ai/glm-5.3-flash", ["anthropic/claude-haiku-4.5"]) == "anthropic/claude-haiku-4.5"
    # All-glob allow list with no literal entry: nothing to fall back to, so pass through.
    assert _model_within_allowance("z-ai/glm-5.3-flash", ["anthropic/*"]) == "z-ai/glm-5.3-flash"


async def test_apply_worker_secret_env_stamps_the_resolved_model_slug(env) -> None:
    """The concrete model a spawn actually resolves to lands on the process itself.

    A wizard step (or a transcript header) that wants to say what really ran — not the
    tier requested, not the vendor default — has to read it from somewhere real; this is
    the one place ``WorkerApiAuth.model_slug`` is computed, so it is the one place that
    persists it."""
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import apply_worker_secret_env
    from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness_api("deepagents")

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=WorkerType.DEEPAGENTS,
        workdir="/tmp",
        pty_mode=False,
        load_flowpad_assistant=False,
    )
    assert process.resolved_model_slug is None
    await apply_worker_secret_env({}, process)
    assert process.resolved_model_slug == "z-ai/glm-5.3-flash"


async def test_deepagents_has_no_device_login_to_fall_back_on(env) -> None:
    """Nothing stored, nothing bound: every other harness answers ``None`` here ("use your device
    login"). This one has no account of its own, so ``None`` would mean a worker spawned with no
    credentials at all — it must be a loud spawn error instead."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates

    def device_rungs(candidates):
        return [c for c in candidates if str(c.endpoint.kind) == "device"]

    assert device_rungs(await list_llm_candidates("deepagents")) == []
    assert device_rungs(await list_llm_candidates("claude"))
    with pytest.raises(WorkerSpawnError):
        await resolve_worker_api_auth(_fake_process("deepagents"))


# ── --model <family>:<size> ─────────────────────────────────────────────────────────────────


#: The family table, spelled out here so a change to it is a deliberate edit in two places: every
#: slug must be one the hub can price (a cost-capped endpoint refuses an unpriced model).
FAMILY_TABLE = {
    "kimi": ("moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2.6"),
    "glm": ("z-ai/glm-4.7", "z-ai/glm-5", "z-ai/glm-5.3"),
    "openai": ("openai/gpt-oss-20b", "openai/gpt-oss-120b", "openai/gpt-5"),
    "claude": ("anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.8"),
}


@pytest.mark.parametrize("family", sorted(FAMILY_TABLE))
def test_every_family_size_resolves_to_its_slug(family) -> None:
    from flow_sdk.builtin.agentic_process.model_tiers import resolve_family_tier

    for size, slug in zip(("sm", "md", "lg"), FAMILY_TABLE[family]):
        assert resolve_family_tier(f"{family}:{size}") == slug
        assert resolve_family_tier(f"{family.upper()}:{size.upper()}") == slug  # a person's casing


def test_what_is_not_family_syntax_is_left_alone() -> None:
    from flow_sdk.builtin.agentic_process.model_tiers import is_family_model, resolve_family_tier

    for model in (None, "", "sm", "lg", "z-ai/glm-4.7", "z-ai/glm-4.5-air:free", "haiku"):
        assert not is_family_model(model)
        assert resolve_family_tier(model) is None
    with pytest.raises(ValueError, match="sm, md, lg"):
        resolve_family_tier("kimi:xl")


#: Every funded harness, and the slug ``kimi:md`` must reach it as -- opencode addresses every
#: model as ``<provider>/<model>``; the rest take the gateway slug bare.
FAMILY_SPELLING = {
    "claude": "moonshotai/kimi-k2.5",
    "codex": "moonshotai/kimi-k2.5",
    "copilot": "moonshotai/kimi-k2.5",
    "opencode": "openrouter/moonshotai/kimi-k2.5",
    "deepagents": "moonshotai/kimi-k2.5",
}


@pytest.mark.parametrize("worker", sorted(FAMILY_SPELLING))
async def test_a_family_model_reaches_each_hub_funded_worker_spelled_its_way(env, monkeypatch, worker) -> None:
    """``flow process start --worker <w> --model kimi:md`` on a box bound to a hub endpoint: the
    slug the binding resolves is what the spawn stamps onto the worker's command."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import (
        apply_api_model_to_options,
        resolve_worker_api_auth,
    )

    _bind_hub(monkeypatch)
    await _set_harness_api(worker, provider="flowpad")

    process = _fake_process(worker, model="kimi:md")
    auth = await resolve_worker_api_auth(process)
    assert auth is not None and auth.model_slug == FAMILY_SPELLING[worker]
    cmd = SimpleNamespace(model="kimi:md")
    await apply_api_model_to_options(cmd, process)
    assert cmd.model == FAMILY_SPELLING[worker]


async def test_a_family_model_is_not_swapped_for_a_models_allow_default(env) -> None:
    """The models_allow fallback rescues a CODE default; a model the caller named is the
    caller's choice, and an endpoint that refuses it should say so rather than run another."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate

    candidate = _hub_candidate("course-ep", "AI Course budget", ["anthropic/claude-haiku-4.5"])

    auth = await binding_for_candidate("deepagents", candidate, tier="glm:sm")
    assert auth is not None and auth.model_slug == "z-ai/glm-4.7"


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        # The caller's model -- a name or a literal slug -- is kept, so the endpoint can refuse it.
        ("haiku", "haiku"),
        ("anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"),
        # A size, or no model at all, is the tier map's code default: still re-picked.
        ("sm", "z-ai/glm-5.3"),
        (None, "z-ai/glm-5.3"),
    ],
)
async def test_a_named_model_is_not_swapped_for_a_models_allow_default(env, tier, expected) -> None:
    """A GLM-only allowance asked for haiku must not quietly run GLM: the turn would answer, bill
    the allowance, and the caller would never learn their model was refused."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate

    candidate = _hub_candidate("glm-ep", "GLM 5.3 only", ["z-ai/glm-5.3"])

    auth = await binding_for_candidate("claude_code", candidate, tier=tier)
    assert auth is not None and auth.model_slug == expected


async def test_a_family_model_with_a_bad_size_fails_the_spawn_with_the_sizes(env, monkeypatch) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError

    _bind_hub(monkeypatch)
    await _set_harness_api("deepagents", provider="flowpad")

    with pytest.raises(WorkerSpawnError, match="sm, md, lg"):
        await resolve_worker_api_auth(_fake_process("deepagents", model="glm:huge"))


async def test_a_family_model_on_a_device_login_is_refused_in_a_sentence(env) -> None:
    """A device login runs the vendor's own models; ``kimi:sm`` names nothing there."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError

    await _signed_in("claude")
    with pytest.raises(WorkerSpawnError, match="model family.*flow llm user use"):
        await resolve_worker_api_auth(_fake_process("claude", model="kimi:sm"))
    # A tier on the same login is still the vendor's to resolve.
    assert await resolve_worker_api_auth(_fake_process("claude", model="sm")) is None


@pytest.mark.parametrize("worker", sorted(FAMILY_SPELLING))
def test_a_specs_own_tier_slugs_are_spelled_with_its_prefix(worker) -> None:
    """``slug_prefix`` is how the harness spells a model; its own tier slugs already are."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import driver_api_auth_spec

    spec = driver_api_auth_spec(worker)
    assert all(slug.startswith(spec.slug_prefix) for slug in spec.tier_models.values())
