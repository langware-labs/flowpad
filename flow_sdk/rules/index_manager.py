"""Manage index.md for skill rules."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class IndexManager:
    """Manages the index.md file for tracking skill rules."""

    def __init__(self, rules_dir: Path):
        self.rules_dir = rules_dir
        self.index_file = rules_dir / "index.md"

    def load_index(self) -> dict[str, Any]:
        """Parse index.md and return structured data."""
        if not self.index_file.exists():
            return {
                "rules": [],
                "last_updated": None,
                "raw_content": "",
            }

        content = self.index_file.read_text(encoding="utf-8")
        rules: list[dict[str, Any]] = []
        last_updated = None

        # Parse last updated timestamp
        updated_match = re.search(r"Last updated:\s*(\S+)", content)
        if updated_match:
            last_updated = updated_match.group(1)

        # Parse rules table
        table_pattern = r"\|\s*(\S+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|"
        in_table = False

        for line in content.split("\n"):
            if "| Rule Name |" in line:
                in_table = True
                continue
            if in_table and line.strip().startswith("|---"):
                continue
            if in_table and line.strip().startswith("|"):
                match = re.match(table_pattern, line)
                if match:
                    rule_name = match.group(1).strip()
                    if rule_name.lower() in ("rule name", "---", "-"):
                        continue
                    rules.append({
                        "name": rule_name,
                        "trigger_summary": match.group(2).strip(),
                        "hook_events": match.group(3).strip(),
                        "actions": match.group(4).strip(),
                        "created": match.group(5).strip(),
                    })
            elif in_table and not line.strip().startswith("|"):
                in_table = False

        return {
            "rules": rules,
            "last_updated": last_updated,
            "raw_content": content,
        }

    def save_index(self, rules: list[dict[str, Any]]) -> None:
        """Write index.md with updated rules list."""
        now = datetime.now().isoformat(timespec="seconds")

        table_rows = []
        for rule in rules:
            table_rows.append(
                f"| {rule.get('name', '')} | {rule.get('trigger_summary', '')} | "
                f"{rule.get('hook_events', '')} | {rule.get('actions', '')} | "
                f"{rule.get('created', '')} |"
            )

        detail_sections = []
        for rule in rules:
            detail = f"""### {rule.get('name', '')}
- **IF**: {rule.get('if_condition', rule.get('trigger_summary', ''))}
- **THEN**: {rule.get('then_action', '')}
- **Hook Events**: {rule.get('hook_events', '')}
- **Actions**: {rule.get('actions', '')}
- **Source**: {rule.get('source', '')}"""
            detail_sections.append(detail)

        content = f"""# Skill Rules Index

Last updated: {now}

## Active Rules

| Rule Name | Trigger Summary | Hook Events | Actions | Created |
|-----------|-----------------|-------------|---------|---------|
{chr(10).join(table_rows) if table_rows else ""}

## Rule Details

{chr(10).join(detail_sections) if detail_sections else "(No rules yet)"}
"""

        self.index_file.write_text(content, encoding="utf-8")
        logger.debug(f"Updated index.md at {self.index_file}")

    def rule_exists(self, rule_name: str) -> bool:
        """Check if a rule already exists."""
        rule_dir = self.rules_dir / rule_name
        if rule_dir.exists() and (rule_dir / "trigger.py").exists():
            return True
        index = self.load_index()
        return any(r["name"] == rule_name for r in index["rules"])

    def add_rule(self, rule_name: str, metadata: dict[str, Any]) -> None:
        """Add a new rule to the index."""
        index = self.load_index()
        rules = index["rules"]

        if any(r["name"] == rule_name for r in rules):
            logger.debug(f"Rule {rule_name} already exists in index, updating instead")
            self.update_rule(rule_name, metadata)
            return

        now = datetime.now().strftime("%Y-%m-%d")
        new_rule = {
            "name": rule_name,
            "trigger_summary": metadata.get("trigger_summary", metadata.get("if_condition", "")),
            "hook_events": metadata.get("hook_events", ""),
            "actions": metadata.get("actions", ""),
            "created": metadata.get("created", now),
            "if_condition": metadata.get("if_condition", ""),
            "then_action": metadata.get("then_action", ""),
            "source": metadata.get("source", ""),
        }
        rules.append(new_rule)
        self.save_index(rules)
        logger.debug(f"Added rule {rule_name} to index")

    def update_rule(self, rule_name: str, metadata: dict[str, Any]) -> None:
        """Update an existing rule in the index."""
        index = self.load_index()
        rules = index["rules"]

        for rule in rules:
            if rule["name"] == rule_name:
                if "trigger_summary" in metadata or "if_condition" in metadata:
                    rule["trigger_summary"] = metadata.get("trigger_summary", metadata.get("if_condition", rule.get("trigger_summary", "")))
                if "hook_events" in metadata:
                    rule["hook_events"] = metadata["hook_events"]
                if "actions" in metadata:
                    rule["actions"] = metadata["actions"]
                if "if_condition" in metadata:
                    rule["if_condition"] = metadata["if_condition"]
                if "then_action" in metadata:
                    rule["then_action"] = metadata["then_action"]
                if "source" in metadata:
                    rule["source"] = metadata["source"]
                break
        else:
            self.add_rule(rule_name, metadata)
            return

        self.save_index(rules)
        logger.debug(f"Updated rule {rule_name} in index")

    def remove_rule(self, rule_name: str) -> bool:
        """Remove a rule from the index."""
        index = self.load_index()
        rules = index["rules"]
        original_count = len(rules)

        rules = [r for r in rules if r["name"] != rule_name]

        if len(rules) < original_count:
            self.save_index(rules)
            logger.debug(f"Removed rule {rule_name} from index")
            return True

        return False

    def find_similar_rule(self, trigger_pattern: str, threshold: float = 0.7) -> str | None:
        """Find a rule with a similar trigger pattern."""
        index = self.load_index()

        trigger_lower = trigger_pattern.lower()
        trigger_words = set(trigger_lower.split())

        for rule in index["rules"]:
            rule_trigger = rule.get("trigger_summary", "").lower()
            rule_words = set(rule_trigger.split())

            if not rule_words or not trigger_words:
                continue

            overlap = len(trigger_words & rule_words)
            total = len(trigger_words | rule_words)
            similarity = overlap / total if total > 0 else 0

            if similarity >= threshold:
                logger.debug(f"Found similar rule: {rule['name']} (similarity: {similarity:.2f})")
                return rule["name"]

        return None

    def get_all_rules_metadata(self) -> list[dict[str, Any]]:
        """Get metadata for all rules in the index."""
        return self.load_index()["rules"]

    def sync_with_filesystem(self) -> None:
        """Sync index.md with actual rule directories on filesystem."""
        index = self.load_index()
        rules = index["rules"]
        indexed_names = {r["name"] for r in rules}

        disk_rules = set()
        for item in self.rules_dir.iterdir():
            if item.is_dir() and (item / "trigger.py").exists():
                disk_rules.add(item.name)

        for rule_name in disk_rules - indexed_names:
            rule_md = self.rules_dir / rule_name / "rule.md"
            metadata = {}
            if rule_md.exists():
                metadata = self._parse_rule_md(rule_md)
            metadata["source"] = "filesystem sync"
            self.add_rule(rule_name, metadata)
            logger.debug(f"Synced rule {rule_name} from filesystem")

        for rule_name in indexed_names - disk_rules:
            logger.debug(f"WARNING: Rule {rule_name} in index but not found on disk")

    def _parse_rule_md(self, rule_md: Path) -> dict[str, Any]:
        """Parse a rule.md file for metadata."""
        content = rule_md.read_text(encoding="utf-8")
        metadata: dict[str, Any] = {}

        if_match = re.search(r"\*\*IF\*\*:\s*(.+?)(?:\n|$)", content, re.IGNORECASE)
        if if_match:
            metadata["if_condition"] = if_match.group(1).strip()

        then_match = re.search(r"\*\*THEN\*\*:\s*(.+?)(?:\n|$)", content, re.IGNORECASE)
        if then_match:
            metadata["then_action"] = then_match.group(1).strip()

        hooks_match = re.search(r"\*\*Hook Events\*\*:\s*(.+?)(?:\n|$)", content, re.IGNORECASE)
        if hooks_match:
            metadata["hook_events"] = hooks_match.group(1).strip()

        actions_match = re.search(r"\*\*Actions\*\*:\s*(.+?)(?:\n|$)", content, re.IGNORECASE)
        if actions_match:
            metadata["actions"] = actions_match.group(1).strip()

        return metadata


def get_index_manager(rules_dir: Path | str) -> IndexManager:
    """Get an IndexManager for the specified rules directory."""
    return IndexManager(Path(rules_dir))
