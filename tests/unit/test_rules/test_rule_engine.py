"""Tests for the rule engine core."""

import json
import shutil
from pathlib import Path

import pytest

from flow_sdk.rules import (
    RulesPackage,
    RuleEngine,
    create_rule_engine,
    evaluate_hooks_with_rules,
    Action,
    TriggerResult,
    ActivationRule,
)
from flow_sdk.hooks.types.hooks import HookEventType


@pytest.fixture
def rules_dir(tmp_path) -> Path:
    """Create a temp rules dir with test_rule copied in."""
    rules = tmp_path / "skill_rules"
    src = Path(__file__).parent / "sample_rules" / "test_rule"
    shutil.copytree(src, rules / "test_rule")
    return rules


def test_rules_package_from_folder(rules_dir):
    pkg = RulesPackage.from_folder(rules_dir, source="user")
    assert len(pkg) == 1
    assert "test_rule" in pkg
    assert pkg.get("test_rule") is not None


def test_rules_package_run(rules_dir):
    pkg = RulesPackage.from_folder(rules_dir, source="user")
    hooks_data = {
        "hookEvent": "UserPromptSubmit",
        "session_id": "s1",
        "prompt": "help with test_keyword",
    }
    result = pkg.run(hooks_data)
    assert "_triggered_rules" in result


def test_rules_package_crud(rules_dir):
    pkg = RulesPackage.from_folder(rules_dir, source="user")
    assert len(pkg) == 1

    # Delete
    assert pkg.delete("test_rule") is True
    assert len(pkg) == 0
    assert pkg.delete("nonexistent") is False


def test_rules_package_from_multiple_folders(rules_dir, tmp_path):
    system_dir = tmp_path / "system_rules"
    system_dir.mkdir()
    # Copy sample rule into system dir
    src = Path(__file__).parent / "sample_rules" / "test_rule"
    shutil.copytree(src, system_dir / "test_rule")

    pkg = RulesPackage.from_multiple_folders(
        system_path=system_dir,
        user_path=rules_dir,
    )
    # user overrides system
    assert len(pkg) == 1
    rule = pkg.get("test_rule")
    assert rule.scope == "user"


def test_rule_engine_evaluate(rules_dir, monkeypatch):
    # Point system rules to empty dir to avoid loading SDK system rules
    empty_dir = rules_dir.parent / "empty_system"
    empty_dir.mkdir()

    engine = RuleEngine(system_rules_dir=empty_dir)
    # Monkeypatch user rules dir to our test dir
    monkeypatch.setattr("flow_sdk.rules.engine.get_user_rules_dir", lambda: rules_dir)

    hooks_data = {
        "hookEvent": "UserPromptSubmit",
        "session_id": "s1",
        "prompt": "help with test_keyword",
    }
    result = engine.evaluate_rules(hooks_data)
    assert "_triggered_rules" in result


def test_rule_engine_no_trigger(rules_dir, monkeypatch):
    empty_dir = rules_dir.parent / "empty_system"
    empty_dir.mkdir(exist_ok=True)

    engine = RuleEngine(system_rules_dir=empty_dir)
    monkeypatch.setattr("flow_sdk.rules.engine.get_user_rules_dir", lambda: rules_dir)

    hooks_data = {
        "hookEvent": "UserPromptSubmit",
        "session_id": "s1",
        "prompt": "no match here",
    }
    result = engine.evaluate_rules(hooks_data)
    assert result == {}


def test_evaluate_hooks_with_rules_function(rules_dir, monkeypatch):
    empty_dir = rules_dir.parent / "empty_system"
    empty_dir.mkdir(exist_ok=True)

    monkeypatch.setattr("flow_sdk.rules.engine.get_user_rules_dir", lambda: rules_dir)
    monkeypatch.setattr("flow_sdk.rules.rule_loader._SDK_SYSTEM_RULES_DIR", empty_dir)

    hooks_data = {
        "hookEvent": "UserPromptSubmit",
        "session_id": "s1",
        "prompt": "help with test_keyword",
    }
    result = evaluate_hooks_with_rules(hooks_data)
    assert "_triggered_rules" in result
