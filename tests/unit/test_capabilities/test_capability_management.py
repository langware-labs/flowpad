"""MCP→harness dependency wiring + intent-based capability management."""

from __future__ import annotations

import pytest

from flow_sdk.core.capabilities.mcp import (
    _spec_for,
    harness_kind_for_worker_type,
)
from flow_sdk.core.capabilities.models import CapabilityKind


def _entry(worker_type: str) -> dict:
    return {
        "service": "gmail",
        "worker_type": worker_type,
        "record_ids": ["abc"],
        "names": ["claude.ai Gmail"],
    }


def test_worker_type_to_harness_mapping() -> None:
    assert harness_kind_for_worker_type("claude_code") == CapabilityKind.CLAUDE_CLI.value
    assert harness_kind_for_worker_type("claude_code_cli") == CapabilityKind.CLAUDE_CLI.value
    assert harness_kind_for_worker_type("codex") == CapabilityKind.CODEX_CLI.value
    assert harness_kind_for_worker_type("copilot") == CapabilityKind.COPILOT_CLI.value
    # Config-owning agents FlowPad never spawns → no harness.
    assert harness_kind_for_worker_type("cursor") is None
    assert harness_kind_for_worker_type("vscode") is None
    assert harness_kind_for_worker_type("claude_desktop") is None


def test_spec_for_executor_depends_on_harness_and_is_runnable() -> None:
    spec = _spec_for("gmail.mcp.claude_code", _entry("claude_code"))
    assert spec.dependent_capability_kinds == [CapabilityKind.CLAUDE_CLI.value]
    assert spec.runnable is True


def test_spec_for_non_executor_has_no_dep_and_is_not_runnable() -> None:
    spec = _spec_for("gmail.mcp.cursor", _entry("cursor"))
    assert spec.dependent_capability_kinds == []
    assert spec.runnable is False
    assert "cursor" in spec.description


def test_resolve_connector_maps_plain_language_to_service() -> None:
    from flow_sdk.core.capabilities.connectors import resolve_connector

    assert resolve_connector("I want email").intent == "gmail"
    assert resolve_connector("set up slack").intent == "slack"
    assert resolve_connector("my calendar").intent == "googlecalendar"
    assert resolve_connector("connect jira").intent == "atlassian"
    assert resolve_connector("something unknown xyz") is None


@pytest.mark.asyncio
async def test_install_for_intent_uses_curated_prompt(monkeypatch) -> None:
    """'I want email' must spawn the setup agent with the gmail catalog prompt,
    never the generic placeholder."""
    import flow_sdk.core.capabilities.connectors as connectors

    captured: dict = {}

    async def _fake_install(spec):
        captured["spec"] = spec
        from flow_sdk.core.capabilities.models import CapabilityResult

        return CapabilityResult(ok=True, available=False, message="started", process_id="pid-1")

    monkeypatch.setattr(connectors, "run_capability_install_process", _fake_install)

    result = await connectors.run_capability_install_for_intent("I want email")
    assert result.process_id == "pid-1"
    spec = captured["spec"]
    assert spec.kind.startswith("gmail.mcp.")
    assert "email" in spec.install_prompt.lower()
    assert spec.install_prompt != "count till 10"


@pytest.mark.asyncio
async def test_install_for_intent_generic_fallback(monkeypatch) -> None:
    import flow_sdk.core.capabilities.connectors as connectors

    captured: dict = {}

    async def _fake_install(spec):
        captured["spec"] = spec
        from flow_sdk.core.capabilities.models import CapabilityResult

        return CapabilityResult(ok=True, available=False, message="started", process_id="pid-2")

    monkeypatch.setattr(connectors, "run_capability_install_process", _fake_install)

    await connectors.run_capability_install_for_intent("frobnicate the widget")
    spec = captured["spec"]
    # Unknown intent → a synthetic spec carrying the generic setup prompt.
    assert spec.install_prompt and spec.install_prompt != "count till 10"
    assert "frobnicate the widget" in spec.install_prompt


def test_worker_capability_kind_agrees_for_every_alias_of_a_worker() -> None:
    """The capability kind must not depend on WHICH name for a worker you hold.

    Claude registers ``worker_type="claude_code"`` against kind
    ``harness.claude.cli``. Interpolating the worker type produced
    ``harness.claude_code.cli`` -- a kind nothing registers -- so every lookup keyed
    by the capability's worker_type reported the CLI as missing while the same lookup
    keyed by the driver name (``claude``) succeeded. Codex and copilot hid it by
    having identical names.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind

    assert worker_capability_kind("claude_code") == CapabilityKind.CLAUDE_CLI.value
    assert worker_capability_kind("claude") == CapabilityKind.CLAUDE_CLI.value
    assert worker_capability_kind("codex") == CapabilityKind.CODEX_CLI.value
    assert worker_capability_kind("copilot") == CapabilityKind.COPILOT_CLI.value


def test_the_registry_pairing_is_what_the_drivers_resolve() -> None:
    """Every registered harness CLI must round-trip worker_type -> kind.

    Guards the pairing at its source: a new harness whose worker_type differs from
    its kind segment (as claude's does) is caught here rather than surfacing as a
    "CLI is not installed" message for a CLI that is installed.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.core.capabilities.registry import get_capability_registry

    registry = get_capability_registry()
    harnesses = [(kind, registry.worker_type_for_kind(kind)) for kind in registry.kinds()]
    harnesses = [(kind, worker) for kind, worker in harnesses if worker]
    assert harnesses, "no harness CLI runners registered — the guard would be vacuous"

    for kind, worker_type in harnesses:
        assert worker_capability_kind(worker_type) == kind, (
            f"{worker_type!r} is registered against {kind!r} but resolves to "
            f"{worker_capability_kind(worker_type)!r}"
        )
