"""Execute trigger.py modules and convert results to TriggerResult."""

from __future__ import annotations

import importlib.util
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Action:
    """Represents an action to be executed by the action executor."""

    type: str
    params: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, **self.params}


@dataclass
class TriggerResult:
    """Result from executing a trigger.py script."""

    trigger: bool = False
    reason: str = ""
    entry_id: str | None = None
    actions: list[Action] = field(default_factory=list)
    rule_name: str = ""
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "trigger": self.trigger,
            "reason": self.reason,
            "entry_id": self.entry_id,
            "actions": [a.to_dict() for a in self.actions],
            "rule_name": self.rule_name,
            "error": self.error,
        }


def _convert_actions_to_result(
    actions: Action | list[Action] | None,
    rule_name: str,
) -> TriggerResult:
    """Convert Action(s) from evaluate() to TriggerResult.

    Args:
        actions: Single Action, list of Actions, or None from evaluate().
        rule_name: Name of the rule for the result.

    Returns:
        TriggerResult with appropriate trigger flag and actions.
    """
    if actions is None:
        return TriggerResult(rule_name=rule_name, trigger=False)

    # Normalize to list
    if isinstance(actions, Action):
        action_list = [actions]
    else:
        action_list = actions

    # Extract reason from first action if available
    reason = ""
    for action in action_list:
        if action.params.get("reason"):
            reason = action.params["reason"]
            break
        if action.params.get("content"):
            reason = f"Added context: {action.type}"
            break

    return TriggerResult(
        trigger=True,
        reason=reason or f"Triggered by {rule_name}",
        actions=action_list,
        rule_name=rule_name,
    )


def execute_trigger(
    rule_path: Path,
    hooks_data: dict[str, Any],
    transcript: list[dict[str, Any]],
    timeout: float = 5.0,
    extra_sys_paths: list[str] | None = None,
) -> TriggerResult:
    """Execute a trigger.py module by importing and calling evaluate().

    Args:
        rule_path: Path to the rule directory containing trigger.py.
        hooks_data: Current hook event data.
        transcript: List of parsed transcript entries.
        timeout: Maximum execution time in seconds (unused, kept for API compatibility).
        extra_sys_paths: Additional paths to add to sys.path during execution.

    Returns:
        TriggerResult with parsed output or error information.
    """
    trigger_file = rule_path / "trigger.py"
    rule_name = rule_path.name

    if not trigger_file.exists():
        return TriggerResult(
            rule_name=rule_name,
            error=f"trigger.py not found at {trigger_file}",
        )

    try:
        # Import trigger.py as a module
        spec = importlib.util.spec_from_file_location(
            f"trigger_{rule_name}",
            trigger_file,
        )
        if spec is None or spec.loader is None:
            return TriggerResult(
                rule_name=rule_name,
                error=f"Could not load trigger.py from {trigger_file}",
            )

        module = importlib.util.module_from_spec(spec)

        # Add rule_path and optional extra paths to sys.path temporarily
        original_path = sys.path.copy()
        sys.path.insert(0, str(rule_path))
        if extra_sys_paths:
            for p in reversed(extra_sys_paths):
                sys.path.insert(0, p)
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path = original_path

        # Check for evaluate() function
        if not hasattr(module, "evaluate"):
            return TriggerResult(
                rule_name=rule_name,
                error="trigger.py missing evaluate() function",
            )

        # Call evaluate(hooks_data, transcript)
        result = module.evaluate(hooks_data, transcript)

        # Convert Action(s) to TriggerResult
        return _convert_actions_to_result(result, rule_name)

    except Exception as e:
        return TriggerResult(
            rule_name=rule_name,
            error=f"Error executing trigger.py: {e}",
        )


def execute_all_triggers(
    rules: list[dict[str, Any]],
    hooks_data: dict[str, Any],
    transcript: list[dict[str, Any]],
    timeout: float = 5.0,
) -> list[TriggerResult]:
    """Execute all triggers and collect results.

    Args:
        rules: List of rule metadata dicts from discover_rules().
        hooks_data: Current hook event data.
        transcript: List of parsed transcript entries.
        timeout: Maximum execution time per trigger (unused, kept for API compatibility).

    Returns:
        List of TriggerResult objects for rules that triggered (trigger=True).
    """
    results: list[TriggerResult] = []

    for rule in rules:
        rule_path = rule.get("path")
        if not rule_path:
            continue

        result = execute_trigger(
            rule_path=Path(rule_path),
            hooks_data=hooks_data,
            transcript=transcript,
            timeout=timeout,
        )

        if result.error:
            logger.debug(f"[{result.rule_name}] Error: {result.error}")
        elif result.trigger:
            logger.debug(f"[{result.rule_name}] Triggered: {result.reason}")
            results.append(result)

    return results
