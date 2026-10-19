"""Catch a broken YAML header the moment an agent writes it.

Agents hand-write ``SKILL.md`` / agent / command headers, and one stray ``'`` or
``: `` makes the whole header unreadable. Nothing noticed at write time, so the
asset silently dropped out and surfaced later as "Some assets could not be
read". Run as a Claude PostToolUse hook (``python -m flow_sdk.assets.frontmatter_check``),
this hands the parser's error back to the agent so it fixes the file in the
same turn. It is a bare module, not a ``flow`` subcommand, because it runs after
every write and the CLI's startup would cost ~5x the check.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

#: Claude tools that write a file.
WRITE_TOOLS = ("Write", "Edit", "MultiEdit")

#: ``.claude/<family>/`` folders whose markdown files carry a YAML header.
_HEADER_FAMILIES = {"skills", "agents", "commands"}


def _carries_header(path: Path) -> bool:
    parts = path.parts
    return path.suffix.lower() == ".md" and any(
        a == ".claude" and b in _HEADER_FAMILIES for a, b in zip(parts, parts[1:])
    )


def frontmatter_error(text: str) -> str | None:
    """The parser's complaint about ``text``'s ``---`` header, or None when it reads."""
    import yaml

    from flow_sdk.assets.frontmatter import _extract_frontmatter

    text = text.lstrip("﻿")
    if not text.startswith("---"):
        return None
    header = _extract_frontmatter(text)
    if header is None:
        return "the frontmatter has an opening `---` but no closing `---`."
    try:
        parsed = yaml.safe_load(header)
    except yaml.YAMLError as exc:
        return str(exc)
    if parsed is not None and not isinstance(parsed, dict):
        return "the frontmatter is not a `key: value` mapping."
    return None


def check_hook_payload(data: dict[str, Any]) -> str | None:
    """The block reason for one PostToolUse payload, or None when there is nothing to say."""
    if data.get("tool_name") not in WRITE_TOOLS:
        return None
    raw = (data.get("tool_input") or {}).get("file_path")
    if not raw or not _carries_header(path := Path(raw)):
        return None
    try:
        error = frontmatter_error(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return None
    if error is None:
        return None
    return (
        f"{path} has a YAML frontmatter that does not parse, so Flowpad and Claude Code cannot load it:\n"
        f"{error}\n"
        "Fix the header now. A value containing `: `, a leading quote, or an apostrophe inside "
        "single quotes breaks YAML — wrap the value in double quotes (escape inner `\"` as `\\\"`), "
        "or write an apostrophe inside single quotes as `''`."
    )


def main() -> None:
    """Hook entry: always exit 0; a problem is Claude's ``decision: block`` on stdout."""
    try:
        reason = check_hook_payload(json.load(sys.stdin))
    except Exception:  # noqa: BLE001 — a hook must never break the worker's turn
        reason = None
    if reason:
        sys.stdout.write(json.dumps({"decision": "block", "reason": reason}) + "\n")


if __name__ == "__main__":
    main()
