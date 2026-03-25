"""Batch JSONL stats PropertyRecord helpers for ClaudeSessionRecord.

All aggregated JSONL stats (message counts, token usage, tools, etc.) are backed
by a single ``_parse_jsonl_stats()`` parse that caches its result in an
instance-level ``_session_batch_stats`` attribute.  Individual stat fields are
``_SessionStatsProp`` descriptors that each read one key from that shared cache.

Backward-compat fallback: when no JSONL path is available (e.g. in unit tests
that construct records directly with keyword arguments), ``_get_session_batch_stats()``
returns ``instance.to_dict()`` so that explicitly-set values are still visible
via the PropertyRecord accessor.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar, TYPE_CHECKING

from flow_sdk.fs_store.property_record import PropertyRecord

if TYPE_CHECKING:
    from flow_sdk.fs_store.record import Record


# ---------------------------------------------------------------------------
# Token-cost rates (USD per 1 million tokens) — January 2026 pricing
# ---------------------------------------------------------------------------
_CLAUDE_MODEL_RATES: dict[str, dict[str, float]] = {
    "claude-opus-4": {"input": 5.00, "output": 25.00},
    "claude-sonnet-4": {"input": 3.00, "output": 15.00},
    "claude-haiku-4": {"input": 1.00, "output": 5.00},
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-opus": {"input": 15.00, "output": 75.00},
    "claude-3-haiku": {"input": 0.25, "output": 1.25},
}
_CLAUDE_DEFAULT_RATE: dict[str, float] = {"input": 3.00, "output": 15.00}


def _estimate_cost(
    input_tokens: int,
    output_tokens: int,
    cache_read: int,
    cache_creation: int,
    model: str | None,
) -> float:
    """Estimate session cost in USD from token counts and model name."""
    rates = _CLAUDE_DEFAULT_RATE
    for key, r in _CLAUDE_MODEL_RATES.items():
        if model and key in model:
            rates = r
            break
    ir = rates["input"] / 1_000_000
    out_r = rates["output"] / 1_000_000
    return (
        input_tokens * ir
        + output_tokens * out_r
        + cache_creation * ir * 1.25
        + cache_read * ir * 0.10
    )


# ---------------------------------------------------------------------------
# JSONL batch parser
# ---------------------------------------------------------------------------

def _parse_jsonl_stats(path: Path) -> dict:
    """Parse *path* as a Claude transcript JSONL and return aggregated stats dict.

    Reads the entire file once and returns a dict with all session metrics:
    counts, token usage, cost, tools, model, and envelope fields (cwd, slug, …).
    """
    session_id = path.stem
    cwd = ""
    version = ""
    git_branch = ""
    slug = ""
    model: str | None = None
    first_timestamp: str | None = None

    message_count = 0
    user_count = 0
    assistant_count = 0
    input_tokens = 0
    output_tokens = 0
    cache_read = 0
    cache_creation = 0
    duration_ms = 0
    tools: set[str] = set()
    has_plan = False
    last_stop_reason: str | None = None

    models_used_counts: dict[str, int] = {}
    last_user_message: str | None = None
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

                if not first_timestamp and raw.get("timestamp"):
                    first_timestamp = raw["timestamp"]
                if raw.get("sessionId") and (not session_id or session_id == path.stem):
                    session_id = raw["sessionId"]
                if not cwd and raw.get("cwd"):
                    cwd = raw["cwd"]
                if not version and raw.get("version"):
                    version = raw["version"]
                if not git_branch and raw.get("gitBranch"):
                    git_branch = raw["gitBranch"]
                if not slug and raw.get("slug"):
                    slug = raw["slug"]

                entry_type = raw.get("type", "")

                if entry_type == "user":
                    message_count += 1
                    user_count += 1
                    if raw.get("planContent"):
                        has_plan = True
                    msg = raw.get("message") or {}
                    content = msg.get("content") if isinstance(msg, dict) else None
                    if isinstance(content, str):
                        text = content.strip()
                        if text and not text.startswith("<"):
                            last_user_message = text[:200]
                            fts_lines.append(f"user: {text}")
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "").strip()
                                if text and not text.startswith("<"):
                                    last_user_message = text[:200]
                                    fts_lines.append(f"user: {text}")
                                break

                elif entry_type == "assistant":
                    message_count += 1
                    assistant_count += 1
                    msg = raw.get("message") or {}
                    last_stop_reason = msg.get("stop_reason")
                    m = msg.get("model")
                    if m:
                        models_used_counts[m] = models_used_counts.get(m, 0) + 1
                    if not model and m:
                        model = m
                    usage = msg.get("usage") or {}
                    input_tokens += usage.get("input_tokens", 0)
                    output_tokens += usage.get("output_tokens", 0)
                    cache_read += usage.get("cache_read_input_tokens", 0)
                    cache_creation += usage.get("cache_creation_input_tokens", 0)
                    for block in msg.get("content") or []:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tools.add(block.get("name", ""))
                        elif isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "").strip()
                            if text:
                                fts_lines.append(f"assistant: {text[:500]}")
                            break

                elif entry_type == "system" and raw.get("subtype") == "turn_duration":
                    duration_ms += raw.get("durationMs", 0)

    except OSError:
        pass

    # Prepend envelope fields to FTS content
    envelope_prefix: list[str] = []
    if slug:
        envelope_prefix.append(slug)
    if cwd:
        envelope_prefix.append(cwd)
    search_content: str | None = "\n".join(envelope_prefix + fts_lines) or None

    primary_model: str | None = (
        max(models_used_counts.items(), key=lambda x: x[1])[0]
        if models_used_counts
        else model
    )
    estimated_cost_usd = _estimate_cost(
        input_tokens, output_tokens, cache_read, cache_creation, primary_model
    )

    try:
        modified_at: str | None = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except OSError:
        modified_at = None

    resolved_session_id = session_id or path.stem
    task_path: str | None = None
    tasks_dir = Path.home() / ".claude" / "tasks" / resolved_session_id
    if tasks_dir.exists() and any(tasks_dir.glob("*.json")):
        task_path = str(tasks_dir)

    return {
        "session_id": session_id,
        "cwd": cwd,
        "version": version,
        "git_branch": git_branch,
        "slug": slug,
        "model": model,
        "message_count": message_count,
        "user_message_count": user_count,
        "assistant_message_count": assistant_count,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_creation,
        "duration_ms": duration_ms,
        "tools_used": sorted(tools),
        "has_plan": has_plan,
        "last_stop_reason": last_stop_reason,
        "project_encoded_name": path.parent.name,
        "last_user_message": last_user_message,
        "modified_at": modified_at,
        "task_path": task_path,
        "estimated_cost_usd": estimated_cost_usd,
        "models_used": sorted(models_used_counts.keys()),
        "primary_model": primary_model,
        "created_at": first_timestamp,
        "search_content": search_content,
    }


# ---------------------------------------------------------------------------
# Instance-level batch stats cache
# ---------------------------------------------------------------------------

def _get_session_batch_stats(instance: "Record") -> dict:
    """Return cached stats dict for *instance*, parsing JSONL on first call.

    On a cache miss the JSONL transcript at ``jsonl_path`` / ``source_file`` is
    parsed once and all aggregated stats are stored in ``instance._session_batch_stats``.

    Fallback: when no valid JSONL path is found, ``instance.to_dict()`` is
    returned so that records created with explicit constructor kwargs (common in
    unit tests) still work transparently.
    """
    cache = getattr(instance, "_session_batch_stats", None)
    if cache is not None:
        return cache

    path_str: str = (
        getattr(instance, "jsonl_path", None)
        or getattr(instance, "_source_file", None)
        or ""
    )
    p = Path(path_str) if path_str else None
    if p and p.is_file() and p.suffix == ".jsonl":
        stats = _parse_jsonl_stats(p)
    else:
        # No JSONL available — use raw instance __dict__ so constructor kwargs work
        # (avoids to_dict() which would trigger property descriptors → recursion)
        stats = {k: v for k, v in object.__getattribute__(instance, "__dict__").items()
                 if not k.startswith("_")}

    object.__setattr__(instance, "_session_batch_stats", stats)
    return stats


# ---------------------------------------------------------------------------
# PropertyRecord descriptor for individual stat fields
# ---------------------------------------------------------------------------

class _SessionStatsProp(PropertyRecord):
    """PropertyRecord descriptor backed by the JSONL batch stats cache.

    Each descriptor instance reads one field from the shared
    ``_session_batch_stats`` dict, which is populated once per record by
    ``_get_session_batch_stats()``.

    ``ttl=-1`` — session stats are immutable once the transcript is written,
    so cached values are kept forever.  Call ``get_prop(name, force=True)``
    to invalidate and re-parse (e.g. for live sessions).
    """

    _record_type: ClassVar[str] = "prop_session_stat"
    _default_ttl: ClassVar[float] = -1  # immutable — cache forever

    def __init__(self, field: str, *, default: Any = None, **kwargs) -> None:
        self._field = field
        super().__init__(default=default, **kwargs)

    def run_discovery(self, instance: "Record", force: bool = False) -> Any:
        if force:
            # Invalidate instance-level cache so stats are re-parsed from JSONL
            try:
                object.__delattr__(instance, "_session_batch_stats")
            except AttributeError:
                pass
        return _get_session_batch_stats(instance).get(self._field, self._default)
