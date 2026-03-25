"""Load file-based rules from .flow/skill_rules/ directories."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flow_sdk.config import FLOW_HOME

logger = logging.getLogger(__name__)

# Default system rules directory: alongside this file
_SDK_SYSTEM_RULES_DIR = Path(__file__).resolve().parent / "system_rules"


def get_system_rules_dir(override: Path | None = None) -> Path:
    """Return the system-level rules directory.

    Args:
        override: Optional path to use instead of the SDK default.

    Returns:
        Path to system rules directory.
    """
    if override:
        return override
    return _SDK_SYSTEM_RULES_DIR


def get_user_rules_dir() -> Path:
    """Return the user-level rules directory (~/.flow/skill_rules)."""
    return FLOW_HOME / "skill_rules"


def get_project_rules_dir(project_dir: str | None = None) -> Path | None:
    """Return the project-level rules directory (<project>/.flow/skill_rules).

    Args:
        project_dir: Path to the project directory. If None, tries to detect from CWD.

    Returns:
        Path to project rules dir, or None if no project context.
    """
    if project_dir:
        project_path = Path(project_dir)
    else:
        project_path = Path.cwd()

    rules_dir = project_path / ".flow" / "skill_rules"
    if rules_dir.exists():
        return rules_dir
    return None


def get_rules_dir(project_dir: str | None = None, prefer_project: bool = True) -> Path:
    """Get the appropriate rules directory.

    Args:
        project_dir: Optional project directory path.
        prefer_project: If True, prefer project rules over user rules.

    Returns:
        Path to the rules directory to use.
    """
    if prefer_project:
        project_rules = get_project_rules_dir(project_dir)
        if project_rules:
            return project_rules
    return get_user_rules_dir()


def ensure_rules_dir(project_dir: str | None = None, create_project: bool = False) -> Path:
    """Ensure the rules directory exists and return its path.

    Args:
        project_dir: Optional project directory path.
        create_project: If True, create project-level dir; otherwise, create user-level.

    Returns:
        Path to the created/existing rules directory.
    """
    if create_project and project_dir:
        rules_dir = Path(project_dir) / ".flow" / "skill_rules"
    else:
        rules_dir = get_user_rules_dir()

    rules_dir.mkdir(parents=True, exist_ok=True)

    # Ensure index.md exists
    index_file = rules_dir / "index.md"
    if not index_file.exists():
        _create_initial_index(index_file)

    return rules_dir


def _create_initial_index(index_file: Path) -> None:
    """Create an initial index.md file."""
    content = """# Skill Rules Index

Last updated: (auto-updated)

## Active Rules

| Rule Name | Trigger Summary | Hook Events | Actions | Created |
|-----------|-----------------|-------------|---------|---------|

## Rule Details

(Rules will be documented here as they are created)
"""
    index_file.write_text(content, encoding="utf-8")
    logger.debug(f"Created initial index.md at {index_file}")


def discover_rules(project_dir: str | None = None) -> list[dict[str, Any]]:
    """Discover all rules from both user and project directories.

    Project rules override user rules with the same name.

    Args:
        project_dir: Optional project directory path.

    Returns:
        List of rule metadata dicts with keys: name, path, source ('user' or 'project').
    """
    rules: dict[str, dict[str, Any]] = {}

    # Load user rules first
    user_dir = get_user_rules_dir()
    if user_dir.exists():
        for rule_dir in user_dir.iterdir():
            if _is_valid_rule_dir(rule_dir):
                rules[rule_dir.name] = {
                    "name": rule_dir.name,
                    "path": rule_dir,
                    "source": "user",
                }

    # Load project rules (override user rules with same name)
    project_rules_dir = get_project_rules_dir(project_dir)
    if project_rules_dir and project_rules_dir.exists():
        for rule_dir in project_rules_dir.iterdir():
            if _is_valid_rule_dir(rule_dir):
                rules[rule_dir.name] = {
                    "name": rule_dir.name,
                    "path": rule_dir,
                    "source": "project",
                }

    # Sort by name for consistent ordering
    return sorted(rules.values(), key=lambda r: r["name"])


def _is_valid_rule_dir(path: Path) -> bool:
    """Check if a path is a valid rule directory (has record.json)."""
    if not path.is_dir():
        return False
    return (path / "record.json").exists()


def load_rule_metadata(rule_name: str, rules_dir: Path) -> dict[str, Any]:
    """Parse rule.md for metadata about a rule.

    Args:
        rule_name: Name of the rule directory.
        rules_dir: Path to the rules directory.

    Returns:
        Dict with metadata: name, description, if_condition, then_action, hook_events, actions, source.
    """
    rule_dir = rules_dir / rule_name
    rule_md = rule_dir / "rule.md"

    metadata: dict[str, Any] = {
        "name": rule_name,
        "description": "",
        "if_condition": "",
        "then_action": "",
        "hook_events": [],
        "actions": [],
        "source": "",
    }

    if not rule_md.exists():
        return metadata

    content = rule_md.read_text(encoding="utf-8")

    # Parse IF/THEN sections
    lines = content.split("\n")
    current_section = None
    section_content: list[str] = []

    for line in lines:
        line_lower = line.lower().strip()

        if line_lower.startswith("**if**:") or line_lower.startswith("- **if**:"):
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = "if_condition"
            content_after = line.split(":", 1)[1].strip() if ":" in line else ""
            section_content = [content_after] if content_after else []
        elif line_lower.startswith("**then**:") or line_lower.startswith("- **then**:"):
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = "then_action"
            content_after = line.split(":", 1)[1].strip() if ":" in line else ""
            section_content = [content_after] if content_after else []
        elif line_lower.startswith("**hook events**:") or line_lower.startswith("- **hook events**:"):
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = "hook_events"
            content_after = line.split(":", 1)[1].strip() if ":" in line else ""
            section_content = [content_after] if content_after else []
        elif line_lower.startswith("**actions**:") or line_lower.startswith("- **actions**:"):
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = "actions"
            content_after = line.split(":", 1)[1].strip() if ":" in line else ""
            section_content = [content_after] if content_after else []
        elif line_lower.startswith("**source**:") or line_lower.startswith("- **source**:"):
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = "source"
            content_after = line.split(":", 1)[1].strip() if ":" in line else ""
            section_content = [content_after] if content_after else []
        elif line_lower.startswith("#"):
            # New heading, store current section
            if current_section and section_content:
                _store_section(metadata, current_section, section_content)
            current_section = None
            section_content = []
            # Check for description in heading
            if "description" in line_lower:
                current_section = "description"
        elif current_section:
            section_content.append(line)

    # Store final section
    if current_section and section_content:
        _store_section(metadata, current_section, section_content)

    return metadata


def _store_section(metadata: dict, section: str, content: list[str]) -> None:
    """Store parsed section content into metadata dict."""
    text = "\n".join(content).strip()

    if section == "hook_events":
        # Parse as comma-separated list
        metadata["hook_events"] = [e.strip() for e in text.split(",") if e.strip()]
    elif section == "actions":
        # Parse as comma-separated list
        metadata["actions"] = [a.strip() for a in text.split(",") if a.strip()]
    else:
        metadata[section] = text


def get_rule_trigger_path(rule_name: str, rules_dir: Path) -> Path | None:
    """Get the path to a rule's trigger.py file.

    Args:
        rule_name: Name of the rule.
        rules_dir: Path to the rules directory.

    Returns:
        Path to trigger.py, or None if not found.
    """
    trigger_path = rules_dir / rule_name / "trigger.py"
    if trigger_path.exists():
        return trigger_path
    return None
