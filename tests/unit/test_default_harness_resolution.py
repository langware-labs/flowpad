"""Capability-derived default_worker — the precedence ladder.

(1) installed + selected HARNESS capability → (2) FLOWPAD_DEFAULT_WORKER env →
(3) claude. Never raises. Fast unit test — the capability boundary is monkeypatched.
"""
import flow_sdk.core.capabilities.registry as cap_registry
from flow_sdk.fs_store.placement import HarnessType, coerce_harness, resolve_default_harness


def test_coerce_harness_maps_kinds_names_and_values():
    # Capability leaf kinds.
    assert coerce_harness("harness.claude.cli") == HarnessType.CLAUDE
    assert coerce_harness("harness.codex.cli") == HarnessType.AGENTS  # codex → .agents standard
    assert coerce_harness("harness.copilot.cli") == HarnessType.COPILOT
    # Driver/worker names + aliases.
    assert coerce_harness("claude_code") == HarnessType.CLAUDE
    assert coerce_harness("codex") == HarnessType.AGENTS
    assert coerce_harness("github") == HarnessType.GITHUB
    # Already a harness value.
    assert coerce_harness("agents") == HarnessType.AGENTS
    # Unknown / empty.
    assert coerce_harness("") is None
    assert coerce_harness("gpt5") is None


async def test_capability_wins_when_available(monkeypatch):
    async def fake_kind():
        return "harness.copilot.cli"

    monkeypatch.setattr(cap_registry, "resolve_default_harness_kind", fake_kind)
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "claude")  # ignored while capability resolves
    assert await resolve_default_harness() == HarnessType.COPILOT


async def test_env_fallback_when_capability_unavailable(monkeypatch):
    async def raising_kind():
        raise RuntimeError("Default harness is not available")

    monkeypatch.setattr(cap_registry, "resolve_default_harness_kind", raising_kind)
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "codex")
    assert await resolve_default_harness() == HarnessType.AGENTS


async def test_ultimate_fallback_is_claude(monkeypatch):
    async def raising_kind():
        raise RuntimeError("nope")

    monkeypatch.setattr(cap_registry, "resolve_default_harness_kind", raising_kind)
    monkeypatch.delenv("FLOWPAD_DEFAULT_WORKER", raising=False)
    assert await resolve_default_harness() == HarnessType.CLAUDE


async def test_unrecognized_capability_kind_falls_through_to_env(monkeypatch):
    async def weird_kind():
        return "harness.unknowntool.cli"

    monkeypatch.setattr(cap_registry, "resolve_default_harness_kind", weird_kind)
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "github")
    assert await resolve_default_harness() == HarnessType.GITHUB
