"""Rule engine module for file-based rules."""

from .activation_rule import (
    ActivationRule,
    ActivationRuleCase,
    EvalCaseResult,
    RuleEvaluation,
)
from .engine import RulesPackage, RuleEngine, create_rule_engine, evaluate_hooks_with_rules
from .trigger_executor import Action, TriggerResult, execute_trigger, execute_all_triggers
from .action_executor import ActionExecutor, ActionResult, execute_actions, format_hook_output
from .rule_loader import (
    discover_rules,
    ensure_rules_dir,
    get_rules_dir,
    get_system_rules_dir,
    get_user_rules_dir,
    get_project_rules_dir,
    load_rule_metadata,
)
from .index_manager import IndexManager, get_index_manager
from .field_extractor import (
    extract_field,
    get_tool_info,
    get_hook_event,
    get_user_prompt,
    is_tool_match,
    get_bash_command,
    get_file_operation,
)
from .regex_utils import (
    compile_regex,
    regex_match,
    regex_match_ignorecase,
    contains,
    starts_with,
    ends_with,
    matches_any,
    extract_match,
    word_boundary_match,
)

__all__ = [
    # Core classes
    "ActivationRule",
    "ActivationRuleCase",
    "EvalCaseResult",
    "RuleEvaluation",
    "RulesPackage",
    "RuleEngine",
    # Trigger/Action system
    "Action",
    "TriggerResult",
    "ActionExecutor",
    "ActionResult",
    "execute_trigger",
    "execute_all_triggers",
    "execute_actions",
    "format_hook_output",
    # Factory functions
    "create_rule_engine",
    "evaluate_hooks_with_rules",
    # Rule loader
    "discover_rules",
    "ensure_rules_dir",
    "get_rules_dir",
    "get_system_rules_dir",
    "get_user_rules_dir",
    "get_project_rules_dir",
    "load_rule_metadata",
    # Index manager
    "IndexManager",
    "get_index_manager",
    # Field extractor
    "extract_field",
    "get_tool_info",
    "get_hook_event",
    "get_user_prompt",
    "is_tool_match",
    "get_bash_command",
    "get_file_operation",
    # Regex utilities
    "compile_regex",
    "regex_match",
    "regex_match_ignorecase",
    "contains",
    "starts_with",
    "ends_with",
    "matches_any",
    "extract_match",
    "word_boundary_match",
]
