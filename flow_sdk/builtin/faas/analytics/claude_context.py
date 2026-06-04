"""Claude Code context-window collector.

Runs `claude -p /context --verbose --output-format stream-json` in a subprocess
(with CLAUDECODE unset to bypass the nested-session guard), extracts the
``local_command_output`` event, and parses the markdown tables into structured data.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess

logger = logging.getLogger(__name__)



# ──────────────────────────────────────────────────────────────────────────────
# Token helpers
# ──────────────────────────────────────────────────────────────────────────────


def _tok_to_int(s: str) -> int:
    """Convert '32.9k', '200k', '1.2m', '493' → int."""
    s = s.strip().lower()
    try:
        if s.endswith("k"):
            return int(float(s[:-1]) * 1_000)
        if s.endswith("m"):
            return int(float(s[:-1]) * 1_000_000)
        return int(float(s))
    except (ValueError, AttributeError):
        return 0


# ──────────────────────────────────────────────────────────────────────────────
# Markdown parser
# ──────────────────────────────────────────────────────────────────────────────


def _parse_table(lines: list[str]) -> list[dict]:
    """Parse a markdown table (header + separator + rows) into a list of dicts."""
    if len(lines) < 3:
        return []
    headers = [h.strip().lower().replace(" ", "_") for h in lines[0].split("|") if h.strip()]
    rows = []
    for row in lines[2:]:  # skip separator
        cells = [c.strip() for c in row.split("|") if c.strip()]
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))
    return rows


def _parse_context_markdown(content: str) -> dict:
    """Parse the /context markdown output into a structured dict."""
    out: dict = {}

    # Model line: "**Model:** claude-sonnet-4-6"
    m = re.search(r"\*\*Model:\*\*\s+(.+)", content)
    out["model"] = m.group(1).strip() if m else "unknown"

    # Tokens line: "**Tokens:** 32.9k / 200k (16%)"
    m = re.search(r"\*\*Tokens:\*\*\s+([\d.]+k?m?)\s*/\s*([\d.]+k?m?)\s*\((\d+)%\)", content)
    if m:
        used_str = m.group(1)
        total_str = m.group(2)
        out["tokens_used_str"] = used_str
        out["tokens_total_str"] = total_str
        out["tokens_pct"] = int(m.group(3))
        out["tokens_used"] = _tok_to_int(used_str)
        out["tokens_total"] = _tok_to_int(total_str)
        out["tokens_free"] = out["tokens_total"] - out["tokens_used"]

    # Parse sections: split on "### " headings
    sections = re.split(r"###\s+", content)
    for section in sections:
        lines = [l for l in section.splitlines() if l.strip()]
        if not lines:
            continue
        title = lines[0].strip().lower().replace(" ", "_")
        table_lines = [l for l in lines[1:] if l.startswith("|")]
        if len(table_lines) >= 3:
            rows = _parse_table(table_lines)
            # Enrich numeric fields
            for row in rows:
                for field in ("tokens", "token"):
                    if field in row:
                        row[f"{field}_int"] = _tok_to_int(row[field])
                if "percentage" in row:
                    try:
                        row["percentage_float"] = float(row["percentage"].rstrip("%"))
                    except (ValueError, AttributeError):
                        pass
            out[title] = rows

    return out


# ──────────────────────────────────────────────────────────────────────────────
# Subprocess runner
# ──────────────────────────────────────────────────────────────────────────────


def _find_claude_binary() -> str:
    """Resolve the claude binary, searching common install locations."""
    # shutil.which respects the current PATH
    found = shutil.which("claude")
    if found:
        return found
    # Common install locations when PATH is stripped (e.g. server subprocess)
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        os.path.join(home, ".npm", "bin", "claude"),
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return "claude"  # fallback, will fail with FileNotFoundError


def get_claude_context_sync(session_id: str | None = None, session_title: str | None = None) -> dict:
    """Run `claude -p /context` (optionally with --resume {session_id}) and return parsed data.

    Args:
        session_id: Claude session UUID to resume (shows that session's context).
                    If None, runs without --resume (empty/new session context).
        session_title: Human-readable title for this session (from session discovery).

    Returns an empty dict on any error.
    """
    # Strip CLAUDECODE so the nested-session guard doesn't block us.
    # Also ensure PATH includes common install dirs so the binary is found.
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    home = os.path.expanduser("~")
    extra_paths = [
        os.path.join(home, ".local", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
    ]
    existing_path = env.get("PATH", "")
    env["PATH"] = ":".join(extra_paths) + (":" + existing_path if existing_path else "")

    claude_bin = _find_claude_binary()

    cmd = [claude_bin]
    if session_id:
        cmd += ["--resume", session_id]
    cmd += ["-p", "/context", "--verbose", "--output-format", "stream-json"]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            env=env,
            timeout=15,
        )
    except FileNotFoundError:
        logger.debug("claude binary not found")
        return {}
    except subprocess.TimeoutExpired:
        logger.debug("claude /context timed out")
        return {}
    except Exception as exc:
        logger.debug("claude /context failed: %s", exc)
        return {}

    data: dict = {}
    for line in proc.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Claude Code <=2.1.34: system/local_command_output
        if event.get("type") == "system" and event.get("subtype") == "local_command_output":
            data = _parse_context_markdown(event.get("content", ""))
            break
        # Claude Code >=2.1.69: result/success carries the output in "result"
        if event.get("type") == "result" and event.get("subtype") == "success":
            data = _parse_context_markdown(event.get("result", ""))
            break

    if data:
        data["session_id"] = session_id
        data["session_title"] = session_title
    return data
