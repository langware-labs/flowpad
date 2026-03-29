"""Main rule evaluation engine for file-based rules."""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Iterator

from .activation_rule import ActivationRule
from .rule_loader import (
    get_rules_dir,
    get_user_rules_dir,
    get_project_rules_dir,
    get_system_rules_dir,
)
from .trigger_executor import TriggerResult
from .action_executor import execute_actions, format_hook_output

logger = logging.getLogger(__name__)


def _load_dir(path: Path, source: str) -> list[ActivationRule]:
    """Load all rules from a directory containing <name>/record.json subdirs."""
    if not path or not path.is_dir():
        return []
    rules: list[ActivationRule] = []
    for entry in sorted(path.iterdir()):
        if not entry.is_dir():
            continue
        rj = entry / "record.json"
        if not rj.exists():
            continue
        try:
            rec = ActivationRule.load_record(rj)
            rec.path = str(entry)
            rec.scope = source
            rules.append(rec)
        except (json.JSONDecodeError, OSError):
            continue
    return rules


class RulesPackage:
    """A collection of activation rules from one or more directories."""

    def __init__(
        self,
        path: Path | None = None,
        source: str = "",
        rules: list[ActivationRule] | None = None,
    ):
        self._path = path
        self._source = source
        self._rules: list[ActivationRule] = rules or []

    @property
    def path(self) -> Path | None:
        return self._path

    @property
    def source(self) -> str:
        return self._source

    # -- Constructors --

    @classmethod
    def from_folder(cls, path: Path, source: str = "user") -> "RulesPackage":
        """Create a RulesPackage backed by a single directory."""
        return cls(path=path, source=source, rules=_load_dir(path, source))

    @classmethod
    def from_multiple_folders(
        cls,
        system_path: Path | None = None,
        user_path: Path | None = None,
        project_path: Path | None = None,
    ) -> "RulesPackage":
        """Merge system, user, and project directories with precedence.

        Precedence: project > user > system (later overrides earlier by name).
        """
        by_name: dict[str, ActivationRule] = {}
        for rule in _load_dir(system_path, "system") if system_path else []:
            by_name[rule.name] = rule
        for rule in _load_dir(user_path, "user") if user_path else []:
            by_name[rule.name] = rule
        for rule in _load_dir(project_path, "project") if project_path else []:
            by_name[rule.name] = rule

        merged = sorted(by_name.values(), key=lambda r: r.name)
        return cls(path=project_path, source="merged", rules=merged)

    # -- Collection interface --

    @property
    def rules(self) -> list[ActivationRule]:
        return list(self._rules)

    def __len__(self) -> int:
        return len(self._rules)

    def __iter__(self) -> Iterator[ActivationRule]:
        return iter(self._rules)

    def __contains__(self, name: object) -> bool:
        if not isinstance(name, str):
            return False
        return any(r.name == name for r in self._rules)

    # -- CRUD --

    def get(self, name: str) -> ActivationRule | None:
        for r in self._rules:
            if r.name == name:
                return r
        return None

    def create(self, rule: ActivationRule) -> ActivationRule:
        """Add and persist a new rule. Raises if name already exists."""
        if rule.name in self:
            raise ValueError(f"Rule '{rule.name}' already exists")
        if self._path:
            fp = self._path / rule.name / "record.json"
            fp.parent.mkdir(parents=True, exist_ok=True)
            rule.path = str(fp.parent)
            rule.save_record_json(fp)
        self._rules.append(rule)
        return rule

    def save(self, rule: ActivationRule) -> None:
        """Persist a rule (create or overwrite)."""
        existing = self.get(rule.name)
        if existing:
            self._rules = [r for r in self._rules if r.name != rule.name]
        if self._path:
            fp = self._path / rule.name / "record.json"
            fp.parent.mkdir(parents=True, exist_ok=True)
            rule.path = str(fp.parent)
            rule.save_record_json(fp)
        self._rules.append(rule)

    def delete(self, name: str) -> bool:
        """Remove a rule. Returns True if it existed."""
        rule = self.get(name)
        if rule is None:
            return False
        self._rules = [r for r in self._rules if r.name != name]
        if self._path:
            target = self._path / name
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
        return True

    # -- Domain methods --

    def run(
        self,
        hooks_data: dict[str, Any],
        transcript: list[dict[str, Any]] | None = None,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        return _run_rules(self._rules, hooks_data, transcript, timeout)

    def get_summary(self) -> list[dict[str, str]]:
        return [
            {
                "name": r.name,
                "source": str(r.scope),
                "path": str(r.record_dir) if r.record_dir else "",
            }
            for r in self._rules
        ]

    def find_similar(self, pattern: str, threshold: float = 0.7) -> str | None:
        pattern_words = set(pattern.lower().split())
        for rule in self._rules:
            rule_words = set(rule.if_condition.lower().split())
            if not rule_words or not pattern_words:
                continue
            overlap = len(pattern_words & rule_words)
            total = len(pattern_words | rule_words)
            if (overlap / total if total > 0 else 0) >= threshold:
                return rule.name
        return None

    @property
    def rules_index(self) -> str:
        if not self._rules:
            return "(no rules)"
        return "\n".join(
            f"- {r.name}: {r.description or r.if_condition or ''}"
            for r in self._rules
        )


# =============================================================================
# RuleEngine: delegates to a RulesPackage built via from_multiple_folders
# =============================================================================


class RuleEngine:
    """Composes system, user, and project rules with precedence."""

    def __init__(
        self,
        project_dir: str | None = None,
        system_rules_dir: Path | None = None,
    ):
        self.project_dir = project_dir
        self._system_rules_dir = system_rules_dir
        self._rules_cache: list[dict[str, Any]] | None = None
        self._package: RulesPackage | None = None

    def _get_package(self) -> RulesPackage:
        if self._package is None:
            project_path = get_project_rules_dir(self.project_dir) if self.project_dir else None
            user_path = get_user_rules_dir() if self._user_rules_enabled() else None
            self._package = RulesPackage.from_multiple_folders(
                system_path=get_system_rules_dir(self._system_rules_dir),
                user_path=user_path,
                project_path=project_path,
            )
        return self._package

    @staticmethod
    def _user_rules_enabled() -> bool:
        try:
            from plugin_records.skillit_records import skillit_records
            return skillit_records.config.user_rules_enabled
        except Exception:
            return True

    def all_rules(self) -> list[ActivationRule]:
        return self._get_package().rules

    def discover_rules(self, force_refresh: bool = False) -> list[dict[str, Any]]:
        if self._rules_cache is None or force_refresh:
            if force_refresh:
                self._package = None
            self._rules_cache = [
                {"name": r.name, "path": r.record_dir, "source": str(r.scope)}
                for r in self.all_rules()
            ]
            logger.debug(f"Discovered {len(self._rules_cache)} rules")
        return self._rules_cache

    def evaluate_rules(
        self,
        hooks_data: dict[str, Any],
        transcript: list[dict[str, Any]] | None = None,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        return self._get_package().run(hooks_data, transcript, timeout)

    def evaluate_single_rule(
        self,
        rule_name: str,
        hooks_data: dict[str, Any],
        transcript: list[dict[str, Any]] | None = None,
    ) -> TriggerResult | None:
        rule = self._get_package().get(rule_name)
        if not rule:
            logger.debug(f"Rule not found: {rule_name}")
            return None
        result = rule.run(hooks_data, transcript)
        return result if result.trigger else None

    def get_rules_summary(self) -> list[dict[str, str]]:
        return self._get_package().get_summary()

    def load_rule(self, rule: ActivationRule) -> None:
        rules_base = (
            Path(self.project_dir) / ".flow" / "skill_rules"
            if self.project_dir
            else get_user_rules_dir()
        )
        target_dir = rules_base / rule.name
        target_dir.parent.mkdir(parents=True, exist_ok=True)

        rule_dir = rule.record_dir
        if rule_dir is None:
            raise ValueError("Cannot load rule without record_dir")

        if target_dir.exists():
            shutil.rmtree(target_dir)
        shutil.copytree(rule_dir, target_dir)
        self._package = None
        self._rules_cache = None


# =============================================================================
# Shared execution logic
# =============================================================================

def _run_rules(
    rules: list[ActivationRule],
    hooks_data: dict[str, Any],
    transcript: list[dict[str, Any]] | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    if not rules:
        return {}

    hook_event = (
        hooks_data.get("hookEvent")
        or hooks_data.get("hook_event")
        or hooks_data.get("event")
        or ""
    )

    trigger_results: list[TriggerResult] = []
    for rule in rules:
        result = rule.run(hooks_data, transcript, timeout)
        if result.error:
            logger.debug(f"[{result.rule_name}] Error: {result.error}")
        else:
            log_mode = getattr(rule, 'log_mode', 'activations')
            if result.trigger or log_mode == 'all':
                try:
                    from flow_sdk.fs_records.trigger_log import TriggerLogRecord
                    TriggerLogRecord.append_entry(rule.name, {
                        "hook_event": hook_event,
                        "trigger": result.trigger,
                        "reason": result.reason or "",
                        "is_test": False,
                        "rule_name": rule.name,
                        "actions": [a.type for a in result.actions] if result.actions else [],
                    })
                except Exception:
                    pass
            if result.trigger:
                logger.debug(f"[{result.rule_name}] Triggered: {result.reason}")
                trigger_results.append(result)

    if not trigger_results:
        logger.debug("No rules triggered")
        return {}

    logger.debug(f"Triggered rules: {[r.rule_name for r in trigger_results]}")

    output = execute_actions(
        trigger_results=trigger_results,
        hook_event=hook_event,
        hooks_data=hooks_data,
        transcript=transcript or [],
    )
    exit_code = output.pop("_exit_code", None)
    chain_requests = output.pop("_chain_requests", None)
    formatted = format_hook_output(output, hook_event)
    formatted["_triggered_rules"] = [r.to_dict() for r in trigger_results]
    if exit_code is not None:
        formatted["_exit_code"] = exit_code
    if chain_requests:
        formatted["_chain_requests"] = chain_requests
    return formatted


def create_rule_engine(
    project_dir: str | None = None,
    system_rules_dir: Path | None = None,
) -> RuleEngine:
    return RuleEngine(project_dir=project_dir, system_rules_dir=system_rules_dir)


def evaluate_hooks_with_rules(
    hooks_data: dict[str, Any],
    transcript: list[dict[str, Any]] | None = None,
    project_dir: str | None = None,
) -> dict[str, Any]:
    return create_rule_engine(project_dir).evaluate_rules(hooks_data, transcript)
