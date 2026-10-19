"""Hooks sit BELOW triggers, and the dependency may only point one way.

Triggers may depend on hooks. Hooks may not depend on triggers. The whole reason
``AgentHookCallback`` exists as a seam is so rule execution can sit above the
hook layer instead of being wired into it — and the hook layer stays usable (and
testable) without any of the trigger machinery.

This is an architectural rule, so it gets a test rather than a comment.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk" / "builtin"

#: Modules that make up the hook layer. None of them may reach for a trigger.
HOOK_LAYER = (
    ROOT / "agent_hook.py",
    ROOT / "hooks" / "types.py",
    ROOT / "hooks" / "manager.py",
    ROOT / "hooks" / "callbacks.py",
    ROOT / "hooks" / "capabilities.py",
    ROOT / "hooks" / "global_manager.py",
    ROOT / "hooks" / "process_manager.py",
)


def _imported_modules(path: Path) -> set[str]:
    """Every module named by an import in ``path`` — including deferred ones."""
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    return names


@pytest.mark.parametrize("module", HOOK_LAYER, ids=lambda p: p.name)
def test_the_hook_layer_never_imports_a_trigger(module: Path):
    offenders = sorted(m for m in _imported_modules(module) if "trigger" in m)
    assert not offenders, (
        f"{module.name} imports {offenders}. Hooks must not depend on triggers — "
        "run rules from flow_sdk/builtin/trigger_hook_bridge.py instead, which is "
        "allowed to import both."
    )


def test_the_bridge_is_the_one_place_both_layers_meet():
    bridge = ROOT / "trigger_hook_bridge.py"
    assert bridge.exists(), "the bridge is what makes the one-way rule possible"
    source = bridge.read_text()
    assert "trigger_on_tag" in source, "the bridge is what emits the trigger.* envelopes"
    assert "get_triggers" in source, "the bridge is what runs the rules"


def test_removing_the_bridge_would_not_break_hook_configuration():
    """The blast radius of deleting the bridge is 'rules stop firing', nothing more."""
    from flow_sdk.builtin.hooks import HookEventType, HookScope, get_hook_manager

    manager = get_hook_manager("claude")
    assert manager.require(HookEventType.USER_PROMPT_SUBMIT, HookScope.USER) is not None
