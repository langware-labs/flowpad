"""Shared parser/converter helpers — content normalization across workers.

Lifted from the per-worker parsers / Record entry classes so both Claude
and Codex paths use a single implementation.
"""

from __future__ import annotations

import json
from typing import Any

# Cap on file-write content stored on FileWriteEntry. Bounds the JSON
# payload the server ships to the client and the heap footprint of the
# parsed transcript. Full content is recoverable from disk via the file_path.
_WRITE_CONTENT_MAX_CHARS = 16_000


def truncate_file_content(content: str | None) -> str | None:
    """Cap ``FileWriteEntry.content`` length so a 5MB Write doesn't bloat the wire."""
    if content is None or len(content) <= _WRITE_CONTENT_MAX_CHARS:
        return content
    return content[:_WRITE_CONTENT_MAX_CHARS] + f"\n…[truncated, {len(content)} total chars]"


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


# Keys whose values are large/noisy and dominate to_string() output without
# adding analytic value. ``compact_payload`` walks nested dicts and replaces
# these keys' values with ``[truncated, len=N] <head…>``.
_NOISY_KEYS: frozenset[str] = frozenset({
    "base_instructions",
    "user_instructions",
    "developer_instructions",
    "encrypted_content",
    "last_agent_message",
})

# Threshold above which any string under a payload — even when not on the
# noisy-keys list — is truncated. Catches the multi-KB system-prompt-style
# blocks that codex's developer messages embed inside ``content[*].text``.
_LONG_TEXT_THRESHOLD = 2000


def _truncate_str(value: str, max_chars: int = 200) -> str:
    n = len(value)
    head = value[:max_chars].replace("\n", "\\n")
    return f"[truncated, len={n}] {head}…"


def compact_payload(payload: Any, max_chars: int = 200) -> Any:
    """Return a copy of ``payload`` with known-noisy / oversized values truncated.

    Recurses through nested dicts and lists so ``session_meta.payload.base_instructions.text``
    and ``content[*].text`` paths are both caught. Originals are never mutated.
    Truncation rules:
      * Any string value whose key is in :data:`_NOISY_KEYS` → truncated.
      * Any string value longer than :data:`_LONG_TEXT_THRESHOLD` chars → truncated.
    """
    if isinstance(payload, dict):
        out: dict[str, Any] = {}
        for k, v in payload.items():
            if k in _NOISY_KEYS and isinstance(v, str):
                out[k] = _truncate_str(v, max_chars)
            elif k in _NOISY_KEYS and isinstance(v, dict):
                inner = dict(v)
                txt = inner.get("text")
                if isinstance(txt, str):
                    inner["text"] = _truncate_str(txt, max_chars)
                out[k] = inner
            elif isinstance(v, str) and len(v) > _LONG_TEXT_THRESHOLD:
                out[k] = _truncate_str(v, max_chars)
            elif isinstance(v, dict):
                out[k] = compact_payload(v, max_chars)
            elif isinstance(v, list):
                out[k] = [compact_payload(x, max_chars) if isinstance(x, (dict, list)) else x for x in v]
            else:
                out[k] = v
        return out
    if isinstance(payload, list):
        return [compact_payload(x, max_chars) if isinstance(x, (dict, list)) else x for x in payload]
    return payload


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
