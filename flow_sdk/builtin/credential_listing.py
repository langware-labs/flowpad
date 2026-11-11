"""``flow credentials list`` — each credential by name, its variables, and whether its values are here. Never a value.

The same listing is what an agent's session prompt carries under "Credentials:" (``prompt_block``), so the agent
knows which variables its machine's environment holds without ever seeing one.
"""
from __future__ import annotations

from typing import Any, Optional

#: The line under the prompt block: values are in the environment, never in the prompt.
PROMPT_NOTE = "These are loaded into this machine's environment; read them by variable name."


def listing(status: dict[str, Any], *, scope: str = "") -> list[dict[str, Any]]:
    """One row per credential of a ``credentials_status`` answer — ``name``, ``vars`` (variable names) and
    ``available`` (every value it needs is present). The project's own row wins over the user's of that name.
    ``scope``: only rows of that scope (``project``); default every row."""
    rows: dict[str, dict[str, Any]] = {}
    for row in status.get("credentials") or []:
        name = str(row.get("name") or "")
        if scope and row.get("scope") != scope:
            continue
        if not name or (name in rows and row.get("scope") != "project"):
            continue
        rows[name] = {
            "name": name,
            "vars": [str(v.get("env_var")) for v in row.get("vars") or [] if v.get("env_var")],
            "available": row.get("state") == "connected",
        }
    return sorted(rows.values(), key=lambda r: r["name"])


def listing_text(rows: list[dict[str, Any]]) -> str:
    """The rows as aligned text lines: ``<name>  <VAR,VAR>  available|missing``."""
    if not rows:
        return ""
    width = max(len(r["name"]) for r in rows)
    vars_width = max(len(",".join(r["vars"])) for r in rows)
    return "\n".join(
        f"{r['name']:<{width}}   {','.join(r['vars']):<{vars_width}}   {'available' if r['available'] else 'missing'}".rstrip()
        for r in rows
    )


def prompt_block(rows: list[dict[str, Any]]) -> Optional[str]:
    """The "Credentials:" block for a session's system prompt, or None when there are none. Names only."""
    text = listing_text(rows)
    if not text:
        return None
    return f"Credentials:\n{text}\n{PROMPT_NOTE}\n"


__all__ = ["PROMPT_NOTE", "listing", "listing_text", "prompt_block"]
