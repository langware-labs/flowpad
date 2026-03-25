"""ActivationRule class for individual rule management."""

from __future__ import annotations

import importlib.util
import json
import logging
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from .trigger_executor import TriggerResult, Action, _convert_actions_to_result

logger = logging.getLogger(__name__)


@dataclass
class EvalCaseResult:
    """Result from running a single eval case."""

    case_name: str
    passed: bool
    expected: dict
    actual: dict
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_name": self.case_name,
            "passed": self.passed,
            "expected": self.expected,
            "actual": self.actual,
            "error": self.error,
        }


@dataclass
class RuleEvaluation:
    """Aggregated eval results for a rule."""

    rule_name: str
    cases: list[EvalCaseResult] = field(default_factory=list)

    @property
    def passed(self) -> int:
        return sum(1 for c in self.cases if c.passed)

    @property
    def failed(self) -> int:
        return sum(1 for c in self.cases if not c.passed)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def all_passed(self) -> bool:
        return self.total > 0 and self.failed == 0

    def summary_table(self) -> str:
        """Return a formatted summary table."""
        if not self.cases:
            return f"Rule '{self.rule_name}': no eval cases found."

        lines = [
            f"Rule: {self.rule_name}  ({self.passed}/{self.total} passed)\n",
            f"{'Case':<30} {'Expected':>10} {'Actual':>10} {'Result':>8}",
            f"{'-'*30} {'-'*10} {'-'*10} {'-'*8}",
        ]
        for c in self.cases:
            exp_trigger = c.expected.get("trigger", "?")
            act_trigger = c.actual.get("trigger", "?")
            status = "PASS" if c.passed else "FAIL"
            line = f"{c.case_name:<30} {str(exp_trigger):>10} {str(act_trigger):>10} {status:>8}"
            if c.error:
                line += f"\n{'':>30} error: {c.error}"
            lines.append(line)

        lines.append("")
        lines.append(f"Result: {'ALL PASSED' if self.all_passed else f'{self.failed} FAILED'}")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_name": self.rule_name,
            "passed": self.passed,
            "failed": self.failed,
            "total": self.total,
            "cases": [c.to_dict() for c in self.cases],
        }


class ActivationRuleCase:
    """A single eval case that can run itself against a rule's trigger."""

    def __init__(self, case_dir: Path, rule: "ActivationRule"):
        self.case_dir = case_dir
        self.name = case_dir.name
        self._rule = rule

    @property
    def transcript_file(self) -> Path:
        return self.case_dir / "transcript.jsonl"

    @property
    def expected_file(self) -> Path:
        return self.case_dir / "expected_output.json"

    def load_transcript(self) -> list[dict]:
        entries: list[dict] = []
        for line in self.transcript_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                entries.append(json.loads(line))
        return entries

    def load_expected(self) -> dict:
        return json.loads(self.expected_file.read_text(encoding="utf-8"))

    def run_eval(self) -> EvalCaseResult:
        if not self.transcript_file.exists():
            return EvalCaseResult(
                case_name=self.name, passed=False,
                expected={}, actual={},
                error="transcript.jsonl not found",
            )

        if not self.expected_file.exists():
            return EvalCaseResult(
                case_name=self.name, passed=False,
                expected={}, actual={},
                error="expected_output.json not found",
            )

        try:
            expected = self.load_expected()
        except (json.JSONDecodeError, OSError) as e:
            return EvalCaseResult(
                case_name=self.name, passed=False,
                expected={}, actual={},
                error=f"Failed to load expected_output.json: {e}",
            )

        try:
            transcript = self.load_transcript()
        except (json.JSONDecodeError, OSError) as e:
            return EvalCaseResult(
                case_name=self.name, passed=False,
                expected=expected, actual={},
                error=f"Failed to load transcript.jsonl: {e}",
            )

        hooks_data = _extract_hooks_data(transcript)
        result = self._rule.run(hooks_data, transcript)
        actual = result.to_dict()
        passed = _compare_eval(expected, actual)

        return EvalCaseResult(
            case_name=self.name, passed=passed,
            expected=expected, actual=actual,
        )


def _extract_hooks_data(transcript: list[dict]) -> dict:
    for entry in transcript:
        if entry.get("type") == "user":
            msg = entry.get("message", {})
            content = msg.get("content", "") if isinstance(msg, dict) else ""
            return {
                "hookEvent": "UserPromptSubmit",
                "hook_event_name": "UserPromptSubmit",
                "prompt": content,
                "cwd": entry.get("cwd", ""),
            }
    return transcript[0] if transcript else {}


def _compare_eval(expected: dict, actual: dict) -> bool:
    if expected.get("trigger") != actual.get("trigger"):
        return False
    if not expected.get("trigger"):
        return True
    exp_actions = expected.get("actions", [])
    act_actions = actual.get("actions", [])
    if len(exp_actions) != len(act_actions):
        return False
    for exp_a, act_a in zip(exp_actions, act_actions):
        if exp_a.get("type") != act_a.get("type"):
            return False
    return True


class ActivationRule(Record):
    """A single activation rule backed by Record.

    A rule directory contains:
    - record.json: Metadata (name, description, hook_events, etc.)
    - trigger.py: Python script that evaluates whether the rule triggers
    """

    _record_type: ClassVar[str] = RecordType.RULE
    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.RULE)
        kwargs.setdefault("description", "")
        kwargs.setdefault("if_condition", "")
        kwargs.setdefault("then_action", "")
        kwargs.setdefault("hook_events", [])
        kwargs.setdefault("actions", [])
        kwargs.setdefault("log_mode", "activations")
        super().__init__(**kwargs)

    def save_log_mode(self, mode: str) -> None:
        """Update log_mode in record.json."""
        self.log_mode = mode
        self.save()

    def run(
        self,
        hooks_data: dict[str, Any],
        transcript: list[dict[str, Any]] | None = None,
        timeout: float = 5.0,
    ) -> TriggerResult:
        """Execute the rule's trigger.py module."""
        rule_dir = self.record_dir
        if rule_dir is None:
            return TriggerResult(rule_name=self.name, error="No record_dir set for rule")

        trigger_file = rule_dir / "trigger.py"
        if not trigger_file.exists():
            return TriggerResult(rule_name=self.name, error=f"trigger.py not found at {trigger_file}")

        try:
            spec = importlib.util.spec_from_file_location(f"trigger_{self.name}", trigger_file)
            if spec is None or spec.loader is None:
                return TriggerResult(rule_name=self.name, error=f"Could not load trigger.py from {trigger_file}")

            module = importlib.util.module_from_spec(spec)
            original_path = sys.path.copy()
            sys.path.insert(0, str(rule_dir))
            try:
                spec.loader.exec_module(module)
            finally:
                sys.path = original_path

            if not hasattr(module, "evaluate"):
                return TriggerResult(rule_name=self.name, error="trigger.py missing evaluate() function")

            result = module.evaluate(hooks_data, transcript or [])
            return _convert_actions_to_result(result, self.name)

        except Exception as e:
            return TriggerResult(rule_name=self.name, error=f"Error executing trigger.py: {e}")

    def get_eval_cases(self) -> list[ActivationRuleCase]:
        rule_dir = self.record_dir
        if rule_dir is None:
            return []
        eval_dir = rule_dir / "eval"
        if not eval_dir.is_dir():
            return []
        return [
            ActivationRuleCase(case_dir=d, rule=self)
            for d in sorted(eval_dir.iterdir())
            if d.is_dir()
        ]

    def run_eval(self) -> RuleEvaluation:
        evaluation = RuleEvaluation(rule_name=self.name)
        cases = self.get_eval_cases()
        if not cases:
            logger.debug(f"[{self.name}] No eval cases found")
            return evaluation
        for case in cases:
            evaluation.cases.append(case.run_eval())
        return evaluation

    def deploy_to_user(self) -> "ActivationRule":
        from .rule_loader import ensure_rules_dir
        rules_dir = ensure_rules_dir()
        deployed = self._deploy(rules_dir, source="user")
        print(f"Hook {self.name} was deployed to user @ {rules_dir / self.name}")
        return deployed

    def deploy_to_project(self, project_dir: str) -> "ActivationRule":
        from .rule_loader import ensure_rules_dir
        return self._deploy(
            ensure_rules_dir(project_dir=project_dir, create_project=True),
            source="project",
        )

    def _deploy(self, rules_dir: Path, source: str) -> "ActivationRule":
        rule_dir = self.record_dir
        if rule_dir is None:
            raise ValueError("Cannot deploy rule without record_dir")

        target_dir = rules_dir / self.name
        if target_dir.exists():
            shutil.rmtree(target_dir)
        shutil.copytree(rule_dir, target_dir)

        deployed = ActivationRule.init_record(target_dir / "record.json")
        deployed.path = str(target_dir)
        deployed.scope = source
        deployed.save()

        logger.debug(f"Deployed rule '{self.name}' to {rules_dir} (source={source})")
        return deployed

    def is_valid(self) -> bool:
        rule_dir = self.record_dir
        if rule_dir is None:
            return False
        return (rule_dir / "trigger.py").exists()

    def __repr__(self) -> str:
        return f"ActivationRule(name={self.name!r}, path={self.path!r})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ActivationRule):
            return NotImplemented
        return self.name == other.name and self.path == other.path
