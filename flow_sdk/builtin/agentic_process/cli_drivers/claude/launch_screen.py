"""Claude's launch screens and auth refusals — the driver's ``launch_screen`` hook (ANSI-stripped text)."""

from __future__ import annotations

import asyncio
import re

_PROMPT = re.compile(r"(Yes, I trust this folder|Is this a project you created or one you trust)|(running in Bypass Permissions mode)"
                     r'|(Choose the text style that looks best|Select login method|Press Enter to continue)|(❯ (?:Try "|─{3,}))')
_CODES = ("folder_not_trusted", "bypass_warning", "first_run_setup", "ready")
# stderr "API error (attempt 1/11): 401 401 {..."message":"X"}", screen "✻ 401 X · Retrying in", "API Error: 401", "Not logged in"
_AUTH = re.compile(r'(?:API error \(attempt \d+/\d+\): |✻ |API Error: )(40[13])\b(?:.*?"message":"([^"]*)"|([^·\n{]*))|(Not logged in)')


def classify(text: str) -> str | None:  # the latest prompt on screen, ``ready`` for the composer
    last = None
    for last in _PROMPT.finditer(re.sub(r"\s+", " ", text)):
        pass
    return last and _CODES[last.lastindex - 1]


def classify_auth(item: str | dict) -> tuple[str, str] | None:  # stream event, stderr line or screen text
    if isinstance(item, dict):
        status = item.get("error_status") or item.get("status")
        if item.get("subtype") in ("api_retry", "api_error") and status in (401, 403):
            return "key_rejected", f"{status} {item.get('error') or ''}".strip()
        item = str(item.get("result") or "") if item.get("type") == "result" and item.get("is_error") else ""
    if m := _AUTH.search(item):
        return ("signed_out", item.strip()[:200]) if m.group(4) else ("key_rejected", f"{m.group(1)} {(m.group(2) or m.group(3) or '').strip()}".strip())
    return None


def trust_prompt_folder(text: str) -> str | None:
    found = re.findall(r"Accessing workspace:\s*\n\s*(\S[^\n]*)", text)
    return found[-1].strip() if found else None


async def apply_launch_fix(fix: str, folder: str | None) -> None:
    from flow_sdk.fs_store.operations.claude_settings import write_claude_flags  # noqa: PLC0415

    await asyncio.to_thread(write_claude_flags, trust_folder=folder if fix == "trust_folder" else None,
                            onboarding=fix == "finish_setup", bypass=fix == "accept_bypass")

