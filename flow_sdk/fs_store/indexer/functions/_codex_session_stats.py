"""Batch JSONL stats PropertyRecord helpers for CodexSessionRecord.

Mirror of ``flow_sdk.fs_store.indexer.functions._claude_session_stats`` but for the
two Codex transcript shapes:

1. **Rollout shape** (``~/.codex/sessions/.../rollout-*.jsonl``):
   ``session_meta`` + stream of ``response_item`` / ``event_msg`` /
   ``turn_context`` / ``token_count`` / ``task_started`` / ``task_complete``.
2. **Stream-event shape** (process-local ``codex_transcript.jsonl`` written by
   ``codex exec --json``): ``thread.*`` / ``turn.*`` / ``item.started`` /
   ``item.completed`` / ``turn.completed``.

The line classification is the canonical one used by
``flow_sdk.transcript_analyzer.parsers.codex.CodexParser``; this module mirrors
it for stats-aggregation only.

Cost: emitted as ``0.0`` for every Codex session — GPT/Codex pricing is not in
the table yet (intentional; tracked as a follow-up).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.fs_store.fs_record import FSRecord


def _extract_user_text(content: Any) -> str | None:
    """Pull the first non-prelude ``input_text`` block from a response_item.

    Codex frames permission/skills XML preludes as ``<...>...</...>`` blocks
    the model never wrote, so we skip text starting with ``<`` (matches the
    pruning at ``parsers/codex.py``).
    """
    if not isinstance(content, list):
        return None
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") not in ("input_text", "output_text"):
            continue
        text = (block.get("text") or "").strip()
        if text and not text.startswith("<"):
            return text
    return None


def _parse_codex_jsonl_stats(path: Path) -> dict:
    """Parse a Codex transcript JSONL and return aggregated stats.

    Reads the entire file once. Handles both rollout and stream-event shapes
    line-by-line; each line is independently classified.
    """
    session_id = ""
    cwd = ""
    version = ""
    originator = ""
    git_branch = ""
    model: str | None = None
    effort: str | None = None
    personality: str | None = None
    approval_policy: str | None = None
    sandbox_policy: str | None = None
    first_timestamp: str | None = None

    message_count = 0
    user_count = 0
    assistant_count = 0
    tool_uses = 0

    input_tokens = 0
    output_tokens = 0
    cache_read_input_tokens = 0
    cache_creation_input_tokens = 0

    last_user_message: str | None = None
    last_assistant_message: str | None = None
    last_stop_reason: str | None = None
    fts_lines: list[str] = []

    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue

                rtype = raw.get("type") or ""
                if not first_timestamp and raw.get("timestamp"):
                    first_timestamp = raw["timestamp"]

                # ── Rollout shape ────────────────────────────────────────────
                if rtype == "session_meta":
                    payload = raw.get("payload") or {}
                    if not session_id and payload.get("id"):
                        session_id = str(payload["id"])
                    if not cwd and payload.get("cwd"):
                        cwd = str(payload["cwd"])
                    if not version and payload.get("cli_version"):
                        version = str(payload["cli_version"])
                    if not originator and payload.get("originator"):
                        originator = str(payload["originator"])
                    git = payload.get("git") or {}
                    if not git_branch and isinstance(git, dict) and git.get("branch"):
                        git_branch = str(git["branch"])
                    continue

                if rtype == "turn_context":
                    payload = raw.get("payload") or {}
                    if payload.get("model"):
                        model = str(payload["model"])
                    if payload.get("effort"):
                        effort = str(payload["effort"])
                    if payload.get("personality"):
                        personality = str(payload["personality"])
                    if payload.get("approval_policy"):
                        approval_policy = str(payload["approval_policy"])
                    sp = payload.get("sandbox_policy")
                    if isinstance(sp, dict) and sp.get("type"):
                        sandbox_policy = str(sp["type"])
                    elif isinstance(sp, str):
                        sandbox_policy = sp
                    continue

                if rtype == "response_item":
                    payload = raw.get("payload") or {}
                    ptype = payload.get("type")
                    if ptype == "message":
                        role = payload.get("role")
                        text = _extract_user_text(payload.get("content"))
                        if text is None:
                            continue
                        if role == "user":
                            message_count += 1
                            user_count += 1
                            last_user_message = text[:200]
                            fts_lines.append(f"user: {text}")
                        elif role in ("assistant", "developer"):
                            message_count += 1
                            assistant_count += 1
                            last_assistant_message = text[:500]
                            fts_lines.append(f"assistant: {text[:500]}")
                    elif ptype in ("function_call", "local_shell_call", "tool_call"):
                        tool_uses += 1
                    continue

                if rtype == "token_count":
                    payload = raw.get("payload") or {}
                    info = payload.get("info") if isinstance(payload, dict) else None
                    usage = None
                    if isinstance(info, dict):
                        usage = info.get("last_token_usage") or info.get("total_token_usage")
                    if isinstance(usage, dict):
                        input_tokens += int(usage.get("input_tokens") or 0)
                        output_tokens += int(usage.get("output_tokens") or 0)
                        cache_read_input_tokens += int(
                            usage.get("cached_input_tokens") or 0
                        )
                    continue

                if rtype == "event_msg":
                    payload = raw.get("payload") or {}
                    ev = payload.get("type")
                    if ev == "turn.completed" and payload.get("reason"):
                        last_stop_reason = str(payload["reason"])
                    continue

                # ── Stream-event shape ───────────────────────────────────────
                if rtype == "thread.started":
                    if not session_id and raw.get("thread_id"):
                        session_id = str(raw["thread_id"])
                    continue

                if rtype == "item.completed":
                    item = raw.get("item") or {}
                    itype = item.get("type")
                    if itype == "agent_message":
                        text = (item.get("text") or "").strip()
                        if text:
                            message_count += 1
                            assistant_count += 1
                            last_assistant_message = text[:500]
                            fts_lines.append(f"assistant: {text[:500]}")
                    elif itype == "command_execution":
                        tool_uses += 1
                    elif itype == "file_change":
                        tool_uses += 1
                    continue

                if rtype == "turn.completed":
                    usage = raw.get("usage") or {}
                    if isinstance(usage, dict):
                        input_tokens += int(usage.get("input_tokens") or 0)
                        output_tokens += int(usage.get("output_tokens") or 0)
                    continue
    except OSError:
        pass

    # ── Derived ──────────────────────────────────────────────────────────────
    envelope_prefix: list[str] = []
    if cwd:
        envelope_prefix.append(cwd)
    if model:
        envelope_prefix.append(model)
    search_content: str | None = "\n".join(envelope_prefix + fts_lines) or None

    try:
        modified_at: str | None = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    return {
        "session_id": session_id or path.stem,
        "cwd": cwd,
        "version": version,
        "originator": originator,
        "git_branch": git_branch,
        "model": model,
        "effort": effort,
        "personality": personality,
        "approval_policy": approval_policy,
        "sandbox_policy": sandbox_policy,
        "message_count": message_count,
        "user_message_count": user_count,
        "assistant_message_count": assistant_count,
        "tool_uses": tool_uses,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
        "last_user_message": last_user_message,
        "last_assistant_message": last_assistant_message,
        "last_stop_reason": last_stop_reason,
        "modified_at": modified_at,
        "created_at": first_timestamp,
        "estimated_cost_usd": 0.0,
        "models_used": [model] if model else [],
        "primary_model": model,
        "search_content": search_content,
        "worker_type": "codex",
    }


def _get_codex_session_batch_stats(instance: "FSRecord") -> dict:
    """Return cached stats dict for *instance*, parsing JSONL on first call."""
    cache = getattr(instance, "_codex_session_batch_stats", None)
    if cache is not None:
        return cache

    path_str: str = (
        getattr(instance, "jsonl_path", None)
        or getattr(instance, "_source_file", None)
        or ""
    )
    p = Path(path_str) if path_str else None
    if p and p.is_file() and p.suffix == ".jsonl":
        stats = _parse_codex_jsonl_stats(p)
    else:
        stats = {
            k: v
            for k, v in object.__getattribute__(instance, "__dict__").items()
            if not k.startswith("_")
        }

    object.__setattr__(instance, "_codex_session_batch_stats", stats)
    return stats
