"""Utilities - constants and helper functions."""

import json
from datetime import datetime
from pathlib import Path


# Path getters — call-time, via InstanceSettings (single source of truth).
# Direct `Path.home() / ".claude"` constructions are a contract violation.


def _user_home() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().user_home


def _claude_home() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    return get_instance_settings().claude_home


def _claude_project_dir() -> Path:
    """Project-scope ~/.claude (cwd-anchored). Falls back to user-level on FS errors."""
    try:
        return Path.cwd() / ".claude"
    except (FileNotFoundError, OSError):
        return _claude_home()


# Pricing constants (per 1M tokens) - January 2026
MODEL_PRICING = {
    "claude-opus-4-6": {"input": 5.00, "output": 25.00},
    "claude-opus-4-5-20251101": {"input": 5.00, "output": 25.00},
    "claude-opus-4-5": {"input": 5.00, "output": 25.00},
    "claude-sonnet-4-5-20250929": {"input": 3.00, "output": 15.00},
    "claude-sonnet-4-5": {"input": 3.00, "output": 15.00},
    "claude-haiku-4-5-20251001": {"input": 1.00, "output": 5.00},
    "claude-haiku-4-5": {"input": 1.00, "output": 5.00},
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-opus": {"input": 15.00, "output": 75.00},
    "claude-3-haiku": {"input": 0.25, "output": 1.25},
    "default": {"input": 3.00, "output": 15.00},
}

CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10


def load_json(path: Path) -> dict | None:
    """Load JSON file, return None if not found or invalid."""
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except (json.JSONDecodeError, IOError, UnicodeDecodeError):
        pass
    return None


def load_jsonl(path: Path, limit: int = None) -> list[dict]:
    """Load JSONL file, return list of entries."""
    entries = []
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if limit and i >= limit:
                        break
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except IOError:
        pass
    return entries


def count_lines(path: Path) -> int:
    """Count lines in a file efficiently."""
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except IOError:
        return 0


def get_file_mtime(path: Path) -> str | None:
    """Get file modification time as ISO string."""
    try:
        if path.exists():
            return datetime.fromtimestamp(path.stat().st_mtime).isoformat()
    except (OSError, IOError):
        pass
    return None


def shorten_path(path: str, use_tilde: bool = True) -> str:
    """Shorten path for display, replacing home with ~."""
    if not path:
        return ""
    home = str(_user_home())
    if use_tilde and path.startswith(home):
        return "~" + path[len(home):]
    return path


def format_bytes(size: int) -> str:
    """Format bytes to human readable string."""
    for unit in ["bytes", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:,.0f} {unit}"
        size /= 1024
    return f"{size:,.0f} TB"


def get_model_pricing(model: str) -> dict:
    """Get pricing for a model, with fuzzy matching."""
    if model in MODEL_PRICING:
        return MODEL_PRICING[model]
    for model_key, pricing in MODEL_PRICING.items():
        if model_key in model or model in model_key:
            return pricing
    return MODEL_PRICING["default"]


def calculate_session_cost(
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_creation_tokens: int,
    primary_model: str | None,
) -> dict:
    """Calculate cost breakdown for a session."""
    pricing = get_model_pricing(primary_model or "default")
    input_rate = pricing["input"] / 1_000_000
    output_rate = pricing["output"] / 1_000_000

    input_cost = input_tokens * input_rate
    output_cost = output_tokens * output_rate
    cache_write_cost = cache_creation_tokens * input_rate * CACHE_WRITE_MULTIPLIER
    cache_read_cost = cache_read_tokens * input_rate * CACHE_READ_MULTIPLIER

    total_cost = input_cost + output_cost + cache_write_cost + cache_read_cost
    savings = cache_read_tokens * input_rate - cache_read_cost

    return {
        "total": total_cost,
        "input": input_cost,
        "output": output_cost,
        "cache_write": cache_write_cost,
        "cache_read": cache_read_cost,
        "savings": savings,
    }
