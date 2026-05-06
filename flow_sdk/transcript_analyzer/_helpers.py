"""Shared parser/converter helpers — content normalization across workers.

Lifted from the per-worker parsers / Record entry classes so both Claude
and Codex paths use a single implementation.
"""

from __future__ import annotations

import json
from typing import Any


def render_block(label: str, value: Any) -> list[str]:
    """Render a labeled multi-line block for ``to_string()`` output.

    Empty / None values produce an empty list (no lines emitted). Strings
    are wrapped verbatim so the caller controls quoting; dicts and lists
    are pretty-printed as JSON. Single-line strings collapse onto the same
    line as the label; multi-line strings indent each subsequent line by
    two spaces under a ``label:`` header.
    """
    if value is None:
        return []
    if isinstance(value, str):
        if not value:
            return []
        if "\n" not in value:
            return [f"{label}: {value}"]
        return [f"{label}:", *("  " + ln for ln in value.split("\n"))]
    if isinstance(value, (dict, list)):
        if not value:
            return []
        text = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)
        return [f"{label}:", *("  " + ln for ln in text.split("\n"))]
    return [f"{label}: {value}"]


def extract_text(content: Any) -> str:
    """Flatten a Claude/anthropic-style ``content`` field to plain text.

    Accepts:
      - ``str`` — returned as-is.
      - ``list`` of blocks — concatenates ``{type:"text", text:"..."}`` blocks
        with ``\\n``. Non-text blocks are skipped.
      - anything else — best-effort ``str()``.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text") or "")
        return "\n".join(parts)
    return str(content)


def extract_thinking(content: Any) -> str | None:
    """Concatenate ``{type:"thinking"}`` blocks from a content list.

    Returns ``None`` if no thinking block is present.
    """
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "thinking":
            parts.append(block.get("thinking") or block.get("text") or "")
    return "\n".join(parts) if parts else None


def flatten_tool_result(content: Any) -> str:
    """Flatten a tool_result ``content`` field to plain text.

    Tool results come as ``str`` or ``list[{type:"text", text:"..."}]``.
    Mirrors ``ClaudeToolResultTranscriptEntry.search_content``.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text") or "")
        return "\n".join(parts)
    return str(content)


def first_block_of_type(content: Any, block_type: str) -> dict:
    """Return the first ``{type: <block_type>}`` block in a content list, or ``{}``."""
    if not isinstance(content, list):
        return {}
    for block in content:
        if isinstance(block, dict) and block.get("type") == block_type:
            return block
    return {}
