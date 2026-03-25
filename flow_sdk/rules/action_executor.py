"""Execute actions and build hook JSON output."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from typing import Any

from flow_sdk.hooks.types.hooks import HookEventType
from .trigger_executor import Action, TriggerResult

logger = logging.getLogger(__name__)


@dataclass
class ActionResult:
    """Result from executing an action."""

    success: bool
    action_type: str
    output: dict[str, Any] | None = None
    should_stop: bool = False  # True if this action should stop further processing


class ActionExecutor:
    """Executes actions and builds hook JSON output."""

    def __init__(self, hook_event: str | HookEventType):
        """Initialize the executor.

        Args:
            hook_event: The current hook event type.
        """
        self.hook_event = str(hook_event)

    def add_context(self, content: str) -> ActionResult:
        """Add context for Claude to see."""
        return ActionResult(
            success=True,
            action_type="add_context",
            output={
                "hookSpecificOutput": {
                    "additionalContext": content,
                }
            },
        )

    def block(self, reason: str) -> ActionResult:
        """Block the current action."""
        if self.hook_event == "PreToolUse":
            return ActionResult(
                success=True,
                action_type="block",
                output={
                    "hookSpecificOutput": {
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                },
                should_stop=True,
            )
        else:
            return ActionResult(
                success=True,
                action_type="block",
                output={
                    "decision": "block",
                    "reason": reason,
                },
                should_stop=True,
            )

    def allow(self, reason: str) -> ActionResult:
        """Explicitly allow/bypass permission."""
        return ActionResult(
            success=True,
            action_type="allow",
            output={
                "hookSpecificOutput": {
                    "permissionDecision": "allow",
                    "permissionDecisionReason": reason,
                }
            },
        )

    def modify_input(self, updates: dict[str, Any]) -> ActionResult:
        """Change tool input before execution."""
        return ActionResult(
            success=True,
            action_type="modify_input",
            output={
                "hookSpecificOutput": {
                    "updatedInput": updates,
                }
            },
        )

    def stderr(self, message: str) -> ActionResult:
        """Write message to stderr."""
        sys.stderr.write(message + "\n")
        logger.debug(f"[stderr] {message}")
        return ActionResult(
            success=True,
            action_type="stderr",
        )

    def exit_code(self, code: int) -> ActionResult:
        """Prepare to exit with specific code."""
        return ActionResult(
            success=True,
            action_type="exit_code",
            output={"exit_code": code},
            should_stop=(code == 2),
        )

    def chain_rule(
        self,
        rule_name: str,
        hooks_data: dict[str, Any],
        transcript: list[dict[str, Any]],
    ) -> ActionResult:
        """Invoke another rule (deferred - returns marker for rule engine)."""
        return ActionResult(
            success=True,
            action_type="chain_rule",
            output={
                "chain_to": rule_name,
                "hooks_data": hooks_data,
                "transcript": transcript,
            },
        )

    def execute_action(
        self,
        action: Action,
        hooks_data: dict[str, Any] | None = None,
        transcript: list[dict[str, Any]] | None = None,
    ) -> ActionResult:
        """Execute a single action."""
        action_type = action.type
        params = action.params

        if action_type == "add_context":
            return self.add_context(params.get("content", ""))

        elif action_type == "block":
            return self.block(params.get("reason", "Blocked by rule"))

        elif action_type == "allow":
            return self.allow(params.get("reason", "Allowed by rule"))

        elif action_type == "modify_input":
            return self.modify_input(params.get("updates", {}))

        elif action_type == "stderr":
            return self.stderr(params.get("message", ""))

        elif action_type == "exit_code":
            return self.exit_code(params.get("code", 0))

        elif action_type == "chain_rule":
            return self.chain_rule(
                params.get("rule_name", ""),
                hooks_data or {},
                transcript or [],
            )

        else:
            logger.debug(f"Unknown action type: {action_type}")
            return ActionResult(success=False, action_type=action_type)


def execute_actions(
    trigger_results: list[TriggerResult],
    hook_event: str,
    hooks_data: dict[str, Any] | None = None,
    transcript: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Execute all actions from trigger results and build hook output.

    Args:
        trigger_results: List of TriggerResult objects with triggered rules.
        hook_event: The current hook event type.
        hooks_data: Current hook event data (for chain_rule).
        transcript: Transcript entries (for chain_rule).

    Returns:
        Combined hook JSON output dict.
    """
    executor = ActionExecutor(hook_event)
    output: dict[str, Any] = {}
    combined_context: list[str] = []
    exit_code_to_use: int | None = None
    chain_requests: list[dict[str, Any]] = []
    executed_actions: list[dict[str, str]] = []

    for result in trigger_results:
        # Prefix messages with rule name (hookify pattern)
        rule_prefix = f"**[{result.rule_name}]**\n"

        for action in result.actions:
            action_result = executor.execute_action(action, hooks_data, transcript)

            if not action_result.success:
                continue

            executed_actions.append({
                "rule": result.rule_name,
                "action": action_result.action_type,
                "params": action.params,
            })

            action_output = action_result.output

            if action_result.action_type == "add_context":
                # Combine contexts from multiple rules
                ctx = action_output.get("hookSpecificOutput", {}).get("additionalContext", "")
                if ctx:
                    combined_context.append(rule_prefix + ctx)

            elif action_result.action_type == "block":
                # Blocking takes priority
                if "decision" in action_output:
                    output["decision"] = "block"
                    reason = action_output.get("reason", "")
                    output["reason"] = rule_prefix + reason
                elif "hookSpecificOutput" in action_output:
                    if "hookSpecificOutput" not in output:
                        output["hookSpecificOutput"] = {}
                    output["hookSpecificOutput"]["permissionDecision"] = "deny"
                    reason = action_output["hookSpecificOutput"].get("permissionDecisionReason", "")
                    output["hookSpecificOutput"]["permissionDecisionReason"] = rule_prefix + reason

            elif action_result.action_type == "allow":
                # Allow only applies if no block has been set
                if "decision" not in output and output.get("hookSpecificOutput", {}).get("permissionDecision") != "deny":
                    if "hookSpecificOutput" not in output:
                        output["hookSpecificOutput"] = {}
                    output["hookSpecificOutput"]["permissionDecision"] = "allow"
                    reason = action_output.get("hookSpecificOutput", {}).get("permissionDecisionReason", "")
                    if reason:
                        output["hookSpecificOutput"]["permissionDecisionReason"] = rule_prefix + reason

            elif action_result.action_type == "modify_input":
                # Merge input updates
                if "hookSpecificOutput" not in output:
                    output["hookSpecificOutput"] = {}
                existing_updates = output["hookSpecificOutput"].get("updatedInput", {})
                new_updates = action_output.get("hookSpecificOutput", {}).get("updatedInput", {})
                output["hookSpecificOutput"]["updatedInput"] = {**existing_updates, **new_updates}

            elif action_result.action_type == "exit_code":
                # Track exit code (last one wins, or first exit 2 wins)
                code = action_output.get("exit_code", 0)
                if exit_code_to_use is None or code == 2:
                    exit_code_to_use = code

            elif action_result.action_type == "chain_rule":
                chain_requests.append(action_output)

            # Stop processing if action says to stop
            if action_result.should_stop:
                break

        # Check if we should stop after this result's actions
        if output.get("decision") == "block" or output.get("hookSpecificOutput", {}).get("permissionDecision") == "deny":
            break

    # Combine all contexts
    if combined_context:
        if "hookSpecificOutput" not in output:
            output["hookSpecificOutput"] = {}
        output["hookSpecificOutput"]["additionalContext"] = "\n\n".join(combined_context)

    # Store chain requests for potential follow-up
    if chain_requests:
        output["_chain_requests"] = chain_requests

    # Store exit code for caller to handle
    if exit_code_to_use is not None:
        output["_exit_code"] = exit_code_to_use

    # Send a single notification with all executed actions
    if executed_actions:
        _notify_rules_executed(hook_event, executed_actions)

    return output


def _notify_rules_executed(hook_event: str, executed_actions: list[dict[str, str]]) -> None:
    """Send a single notification with the ordered list of executed rule actions."""
    try:
        from flow_sdk.discovery.notify import send_log_event

        send_log_event("rules_executed", {
            "hook_event": hook_event,
            "actions": executed_actions,
        })
    except Exception as e:
        logger.debug(f"Failed to send rules_executed notification: {e}")


def format_hook_output(output: dict[str, Any], hook_event: str) -> dict[str, Any]:
    """Ensure output is correctly formatted for the hook event type.

    Args:
        output: The combined output from execute_actions.
        hook_event: The current hook event type.

    Returns:
        Properly formatted output dict.
    """
    # Remove internal fields
    result = {k: v for k, v in output.items() if not k.startswith("_")}

    # Ensure proper structure based on hook event
    if hook_event == "PreToolUse":
        # PreToolUse should use hookSpecificOutput with permissionDecision
        if "decision" in result and result["decision"] == "block":
            # Convert to PreToolUse format
            if "hookSpecificOutput" not in result:
                result["hookSpecificOutput"] = {}
            result["hookSpecificOutput"]["permissionDecision"] = "deny"
            result["hookSpecificOutput"]["permissionDecisionReason"] = result.pop("reason", "Blocked")
            del result["decision"]

    # Add hookEventName to hookSpecificOutput (required by Claude Code hooks API)
    if "hookSpecificOutput" in result and hook_event:
        result["hookSpecificOutput"]["hookEventName"] = hook_event

    return result
