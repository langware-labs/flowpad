"""Cost collector - token usage and cost aggregation by time windows."""

from collections import defaultdict
from datetime import datetime, timedelta

from ..utils import (
    CACHE_READ_MULTIPLIER,
    CACHE_WRITE_MULTIPLIER,
    get_model_pricing,
)

# ─────────────────────────────────────────────────────────────────
# Time Window Key Formatters
# ─────────────────────────────────────────────────────────────────


def format_window_key(timestamp: str | None, window_type: str) -> str | None:
    """Format a timestamp into a time window key.

    Args:
        timestamp: ISO format timestamp string
        window_type: One of 'hourly', 'daily', 'weekly', 'monthly'

    Returns:
        Formatted window key string or None if invalid timestamp
    """
    if not timestamp:
        return None

    try:
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None

    if window_type == "hourly":
        return dt.strftime("%Y-%m-%d-%H")
    elif window_type == "daily":
        return dt.strftime("%Y-%m-%d")
    elif window_type == "weekly":
        return dt.strftime("%Y-W%W")
    elif window_type == "monthly":
        return dt.strftime("%Y-%m")
    else:
        return dt.strftime("%Y-%m-%d")


def get_window_boundaries(window_key: str, window_type: str) -> tuple[str, str]:
    """Get ISO timestamp boundaries for a time window.

    Args:
        window_key: The window key (e.g., "2026-01-28" for daily)
        window_type: One of 'hourly', 'daily', 'weekly', 'monthly'

    Returns:
        Tuple of (start_iso, end_iso) timestamps
    """
    try:
        if window_type == "hourly":
            dt = datetime.strptime(window_key, "%Y-%m-%d-%H")
            end_dt = dt + timedelta(hours=1)
        elif window_type == "daily":
            dt = datetime.strptime(window_key, "%Y-%m-%d")
            end_dt = dt + timedelta(days=1)
        elif window_type == "weekly":
            dt = datetime.strptime(window_key + "-1", "%Y-W%W-%w")
            end_dt = dt + timedelta(weeks=1)
        elif window_type == "monthly":
            dt = datetime.strptime(window_key + "-01", "%Y-%m-%d")
            # Move to first day of next month
            if dt.month == 12:
                end_dt = dt.replace(year=dt.year + 1, month=1)
            else:
                end_dt = dt.replace(month=dt.month + 1)
        else:
            dt = datetime.strptime(window_key, "%Y-%m-%d")
            end_dt = dt + timedelta(days=1)

        return (dt.isoformat(), end_dt.isoformat())
    except (ValueError, AttributeError):
        return (window_key, window_key)


# ─────────────────────────────────────────────────────────────────
# Cost Time Window Data Structure
# ─────────────────────────────────────────────────────────────────


def create_empty_cost_window(window_key: str, window_type: str) -> dict:
    """Create an empty cost time window structure.

    Args:
        window_key: The window key (e.g., "2026-01-28")
        window_type: One of 'hourly', 'daily', 'weekly', 'monthly'

    Returns:
        Empty CostTimeWindow dict
    """
    start, end = get_window_boundaries(window_key, window_type)

    return {
        # Identity
        "window_key": window_key,
        "window_type": window_type,
        "window_start": start,
        "window_end": end,
        # Token Totals
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_cache_creation_tokens": 0,
        "total_tokens": 0,
        # Cost Totals (USD)
        "input_cost_usd": 0.0,
        "output_cost_usd": 0.0,
        "cache_write_cost_usd": 0.0,
        "cache_read_cost_usd": 0.0,
        "total_cost_usd": 0.0,
        # Cache Efficiency
        "cache_hit_rate": 0.0,
        "cache_savings_usd": 0.0,
        "cache_investment_usd": 0.0,
        "net_cache_roi_usd": 0.0,
        # Activity Metrics
        "session_count": 0,
        "message_count": 0,
        "tool_use_count": 0,
        "avg_cost_per_session": 0.0,
        "avg_tokens_per_session": 0.0,
        # Model Breakdown
        "cost_by_model": {},
        "tokens_by_model": {},
        "sessions_by_model": {},
        # Project Breakdown
        "cost_by_project": {},
        "sessions_by_project": {},
    }


def finalize_cost_window(window: dict) -> dict:
    """Calculate derived metrics for a cost window.

    Args:
        window: The cost window dict with raw totals

    Returns:
        The same dict with derived metrics calculated
    """
    # Total tokens
    window["total_tokens"] = (
        window["total_input_tokens"]
        + window["total_output_tokens"]
        + window["total_cache_read_tokens"]
        + window["total_cache_creation_tokens"]
    )

    # Averages
    if window["session_count"] > 0:
        window["avg_cost_per_session"] = window["total_cost_usd"] / window["session_count"]
        window["avg_tokens_per_session"] = window["total_tokens"] / window["session_count"]

    # Cache efficiency
    total_input_equivalent = window["total_input_tokens"] + window["total_cache_read_tokens"]
    if total_input_equivalent > 0:
        window["cache_hit_rate"] = window["total_cache_read_tokens"] / total_input_equivalent

    # Round floats for cleaner output
    for key in [
        "input_cost_usd",
        "output_cost_usd",
        "cache_write_cost_usd",
        "cache_read_cost_usd",
        "total_cost_usd",
        "cache_savings_usd",
        "cache_investment_usd",
        "net_cache_roi_usd",
        "avg_cost_per_session",
        "cache_hit_rate",
    ]:
        if key in window and isinstance(window[key], float):
            window[key] = round(window[key], 6)

    return window


# ─────────────────────────────────────────────────────────────────
# Session Cost Calculation
# ─────────────────────────────────────────────────────────────────


def calculate_session_costs(session: dict) -> dict:
    """Calculate detailed cost breakdown for a session.

    Args:
        session: Session dict with token counts and primary_model

    Returns:
        Dict with cost breakdown
    """
    input_tokens = session.get("input_tokens", 0) or 0
    output_tokens = session.get("output_tokens", 0) or 0
    cache_read_tokens = session.get("cache_read_tokens", 0) or 0
    cache_creation_tokens = session.get("cache_creation_tokens", 0) or 0
    primary_model = session.get("primary_model") or "default"

    pricing = get_model_pricing(primary_model)
    input_rate = pricing["input"] / 1_000_000
    output_rate = pricing["output"] / 1_000_000

    input_cost = input_tokens * input_rate
    output_cost = output_tokens * output_rate
    cache_write_cost = cache_creation_tokens * input_rate * CACHE_WRITE_MULTIPLIER
    cache_read_cost = cache_read_tokens * input_rate * CACHE_READ_MULTIPLIER

    # What we would have paid without cache
    cache_full_cost = cache_read_tokens * input_rate
    cache_savings = cache_full_cost - cache_read_cost

    # Premium paid for cache creation
    cache_investment = cache_creation_tokens * input_rate * (CACHE_WRITE_MULTIPLIER - 1)

    total_cost = input_cost + output_cost + cache_write_cost + cache_read_cost

    return {
        "input_cost": input_cost,
        "output_cost": output_cost,
        "cache_write_cost": cache_write_cost,
        "cache_read_cost": cache_read_cost,
        "total_cost": total_cost,
        "cache_savings": cache_savings,
        "cache_investment": cache_investment,
        "net_cache_roi": cache_savings - cache_investment,
    }


# ─────────────────────────────────────────────────────────────────
# Time Window Aggregation
# ─────────────────────────────────────────────────────────────────


def aggregate_sessions_by_time_window(sessions: list[dict], window_type: str = "daily") -> dict[str, dict]:
    """Aggregate session costs by time window.

    Args:
        sessions: List of session dicts with token data
        window_type: One of 'hourly', 'daily', 'weekly', 'monthly'

    Returns:
        Dict mapping window_key to CostTimeWindow
    """
    windows: dict[str, dict] = {}

    for session in sessions:
        # Use created_at for time bucketing (when session started, not last activity)
        # This gives better historical distribution for cost analysis
        timestamp = session.get("created_at") or session.get("modified_at")
        key = format_window_key(timestamp, window_type)

        if not key:
            continue

        # Initialize window if needed
        if key not in windows:
            windows[key] = create_empty_cost_window(key, window_type)

        w = windows[key]

        # Token totals
        input_tokens = session.get("input_tokens", 0) or 0
        output_tokens = session.get("output_tokens", 0) or 0
        cache_read_tokens = session.get("cache_read_tokens", 0) or 0
        cache_creation_tokens = session.get("cache_creation_tokens", 0) or 0

        w["total_input_tokens"] += input_tokens
        w["total_output_tokens"] += output_tokens
        w["total_cache_read_tokens"] += cache_read_tokens
        w["total_cache_creation_tokens"] += cache_creation_tokens

        # Calculate costs for this session
        costs = calculate_session_costs(session)

        w["input_cost_usd"] += costs["input_cost"]
        w["output_cost_usd"] += costs["output_cost"]
        w["cache_write_cost_usd"] += costs["cache_write_cost"]
        w["cache_read_cost_usd"] += costs["cache_read_cost"]
        w["total_cost_usd"] += costs["total_cost"]
        w["cache_savings_usd"] += costs["cache_savings"]
        w["cache_investment_usd"] += costs["cache_investment"]
        w["net_cache_roi_usd"] += costs["net_cache_roi"]

        # Activity metrics
        w["session_count"] += 1
        w["message_count"] += session.get("message_count", 0) or 0
        w["tool_use_count"] += session.get("tool_uses", 0) or 0

        # Model breakdown
        model = session.get("primary_model") or "unknown"
        session_tokens = input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens

        w["cost_by_model"][model] = w["cost_by_model"].get(model, 0) + costs["total_cost"]
        w["tokens_by_model"][model] = w["tokens_by_model"].get(model, 0) + session_tokens
        w["sessions_by_model"][model] = w["sessions_by_model"].get(model, 0) + 1

        # Project breakdown (keyed by cwd; sessions always have a cwd from the JSONL)
        project = session.get("cwd") or "unknown"
        w["cost_by_project"][project] = w["cost_by_project"].get(project, 0) + costs["total_cost"]
        w["sessions_by_project"][project] = w["sessions_by_project"].get(project, 0) + 1

    # Finalize all windows
    for key in windows:
        windows[key] = finalize_cost_window(windows[key])

    return windows


# ─────────────────────────────────────────────────────────────────
# By-Model Aggregation
# ─────────────────────────────────────────────────────────────────


def aggregate_sessions_by_model(sessions: list[dict]) -> dict[str, dict]:
    """Aggregate session costs by model.

    Args:
        sessions: List of session dicts with token data

    Returns:
        Dict mapping model_name to cost summary
    """
    models: dict[str, dict] = defaultdict(
        lambda: {
            "model": "",
            "session_count": 0,
            "message_count": 0,
            "tool_use_count": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_cache_read_tokens": 0,
            "total_cache_creation_tokens": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
            "cache_savings_usd": 0.0,
            "avg_cost_per_session": 0.0,
        }
    )

    for session in sessions:
        model = session.get("primary_model") or "unknown"
        m = models[model]
        m["model"] = model

        input_tokens = session.get("input_tokens", 0) or 0
        output_tokens = session.get("output_tokens", 0) or 0
        cache_read_tokens = session.get("cache_read_tokens", 0) or 0
        cache_creation_tokens = session.get("cache_creation_tokens", 0) or 0

        m["session_count"] += 1
        m["message_count"] += session.get("message_count", 0) or 0
        m["tool_use_count"] += session.get("tool_uses", 0) or 0
        m["total_input_tokens"] += input_tokens
        m["total_output_tokens"] += output_tokens
        m["total_cache_read_tokens"] += cache_read_tokens
        m["total_cache_creation_tokens"] += cache_creation_tokens

        costs = calculate_session_costs(session)
        m["total_cost_usd"] += costs["total_cost"]
        m["cache_savings_usd"] += costs["cache_savings"]

    # Finalize
    for model_name, m in models.items():
        m["total_tokens"] = (
            m["total_input_tokens"]
            + m["total_output_tokens"]
            + m["total_cache_read_tokens"]
            + m["total_cache_creation_tokens"]
        )
        if m["session_count"] > 0:
            m["avg_cost_per_session"] = round(m["total_cost_usd"] / m["session_count"], 6)
        m["total_cost_usd"] = round(m["total_cost_usd"], 6)
        m["cache_savings_usd"] = round(m["cache_savings_usd"], 6)

    return dict(models)


# ─────────────────────────────────────────────────────────────────
# By-Project Aggregation
# ─────────────────────────────────────────────────────────────────


def aggregate_sessions_by_project(sessions: list[dict]) -> dict[str, dict]:
    """Aggregate session costs by project.

    Args:
        sessions: List of session dicts with token data

    Returns:
        Dict mapping cwd to cost summary
    """
    projects: dict[str, dict] = defaultdict(
        lambda: {
            "cwd": "",
            "session_count": 0,
            "message_count": 0,
            "tool_use_count": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_cache_read_tokens": 0,
            "total_cache_creation_tokens": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
            "cache_savings_usd": 0.0,
            "avg_cost_per_session": 0.0,
            "models_used": {},
            "first_session_date": None,
            "last_session_date": None,
        }
    )

    for session in sessions:
        project = session.get("cwd") or "unknown"
        p = projects[project]
        p["cwd"] = project

        input_tokens = session.get("input_tokens", 0) or 0
        output_tokens = session.get("output_tokens", 0) or 0
        cache_read_tokens = session.get("cache_read_tokens", 0) or 0
        cache_creation_tokens = session.get("cache_creation_tokens", 0) or 0

        p["session_count"] += 1
        p["message_count"] += session.get("message_count", 0) or 0
        p["tool_use_count"] += session.get("tool_uses", 0) or 0
        p["total_input_tokens"] += input_tokens
        p["total_output_tokens"] += output_tokens
        p["total_cache_read_tokens"] += cache_read_tokens
        p["total_cache_creation_tokens"] += cache_creation_tokens

        costs = calculate_session_costs(session)
        p["total_cost_usd"] += costs["total_cost"]
        p["cache_savings_usd"] += costs["cache_savings"]

        # Track models used
        model = session.get("primary_model") or "unknown"
        p["models_used"][model] = p["models_used"].get(model, 0) + 1

        # Track date range
        created = session.get("created_at")
        if created:
            if not p["first_session_date"] or created < p["first_session_date"]:
                p["first_session_date"] = created
            if not p["last_session_date"] or created > p["last_session_date"]:
                p["last_session_date"] = created

    # Finalize
    for project_name, p in projects.items():
        p["total_tokens"] = (
            p["total_input_tokens"]
            + p["total_output_tokens"]
            + p["total_cache_read_tokens"]
            + p["total_cache_creation_tokens"]
        )
        if p["session_count"] > 0:
            p["avg_cost_per_session"] = round(p["total_cost_usd"] / p["session_count"], 6)
        p["total_cost_usd"] = round(p["total_cost_usd"], 6)
        p["cache_savings_usd"] = round(p["cache_savings_usd"], 6)

    return dict(projects)


# ─────────────────────────────────────────────────────────────────
# Cost Overview (Main Entry Point)
# ─────────────────────────────────────────────────────────────────


def get_cost_overview(sessions: list[dict]) -> dict:
    """Generate comprehensive cost overview from sessions.

    Args:
        sessions: List of session dicts with full token data

    Returns:
        Complete cost overview with all aggregations
    """
    if not sessions:
        return {
            "generated_at": datetime.now().isoformat(),
            "session_count": 0,
            "totals": {
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cache_read_tokens": 0,
                "total_cache_creation_tokens": 0,
                "total_tokens": 0,
                "total_cost_usd": 0.0,
                "cache_savings_usd": 0.0,
                "cache_investment_usd": 0.0,
                "net_cache_roi_usd": 0.0,
            },
            "by_day": {},
            "by_week": {},
            "by_month": {},
            "by_model": {},
            "by_project": {},
            "top_sessions_by_cost": [],
        }

    # Calculate totals
    totals = {
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_cache_creation_tokens": 0,
        "total_tokens": 0,
        "total_cost_usd": 0.0,
        "cache_savings_usd": 0.0,
        "cache_investment_usd": 0.0,
        "net_cache_roi_usd": 0.0,
    }

    sessions_with_costs = []
    for session in sessions:
        input_tokens = session.get("input_tokens", 0) or 0
        output_tokens = session.get("output_tokens", 0) or 0
        cache_read_tokens = session.get("cache_read_tokens", 0) or 0
        cache_creation_tokens = session.get("cache_creation_tokens", 0) or 0

        totals["total_input_tokens"] += input_tokens
        totals["total_output_tokens"] += output_tokens
        totals["total_cache_read_tokens"] += cache_read_tokens
        totals["total_cache_creation_tokens"] += cache_creation_tokens

        costs = calculate_session_costs(session)
        totals["total_cost_usd"] += costs["total_cost"]
        totals["cache_savings_usd"] += costs["cache_savings"]
        totals["cache_investment_usd"] += costs["cache_investment"]
        totals["net_cache_roi_usd"] += costs["net_cache_roi"]

        # Track for top sessions
        sessions_with_costs.append(
            {
                "session_id": session.get("name") or session.get("id"),
                "cwd": session.get("cwd"),
                "cost_usd": costs["total_cost"],
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "model": session.get("primary_model"),
                "modified_at": session.get("modified_at"),
            }
        )

    totals["total_tokens"] = (
        totals["total_input_tokens"]
        + totals["total_output_tokens"]
        + totals["total_cache_read_tokens"]
        + totals["total_cache_creation_tokens"]
    )

    # Round totals
    for key in ["total_cost_usd", "cache_savings_usd", "cache_investment_usd", "net_cache_roi_usd"]:
        totals[key] = round(totals[key], 6)

    # Get top sessions by cost
    sessions_with_costs.sort(key=lambda x: x["cost_usd"], reverse=True)
    top_sessions = sessions_with_costs[:10]
    for s in top_sessions:
        s["cost_usd"] = round(s["cost_usd"], 6)

    # Aggregate by time windows
    by_day = aggregate_sessions_by_time_window(sessions, "daily")
    by_week = aggregate_sessions_by_time_window(sessions, "weekly")
    by_month = aggregate_sessions_by_time_window(sessions, "monthly")

    # Sort time windows by key (most recent first)
    by_day = dict(sorted(by_day.items(), key=lambda x: x[0], reverse=True))
    by_week = dict(sorted(by_week.items(), key=lambda x: x[0], reverse=True))
    by_month = dict(sorted(by_month.items(), key=lambda x: x[0], reverse=True))

    # Aggregate by model and project
    by_model = aggregate_sessions_by_model(sessions)
    by_project = aggregate_sessions_by_project(sessions)

    # Sort by_model by cost DESC
    by_model = dict(sorted(by_model.items(), key=lambda x: x[1]["total_cost_usd"], reverse=True))

    # Sort by_project by cost DESC
    by_project = dict(sorted(by_project.items(), key=lambda x: x[1]["total_cost_usd"], reverse=True))

    return {
        "generated_at": datetime.now().isoformat(),
        "session_count": len(sessions),
        "totals": totals,
        "by_day": by_day,
        "by_week": by_week,
        "by_month": by_month,
        "by_model": by_model,
        "by_project": by_project,
        "top_sessions_by_cost": top_sessions,
    }


# ─────────────────────────────────────────────────────────────────
# Convenience Functions for Specific Queries
# ─────────────────────────────────────────────────────────────────


def get_cost_for_date_range(sessions: list[dict], start_date: str, end_date: str) -> dict:
    """Get cost summary for a specific date range.

    Args:
        sessions: List of session dicts
        start_date: ISO date string (inclusive)
        end_date: ISO date string (inclusive)

    Returns:
        Cost summary for the date range
    """
    filtered = []
    for session in sessions:
        modified = session.get("modified_at") or session.get("created_at")
        if modified and start_date <= modified <= end_date:
            filtered.append(session)

    return get_cost_overview(filtered)


def get_today_cost(sessions: list[dict]) -> dict:
    """Get cost summary for today.

    Args:
        sessions: List of session dicts

    Returns:
        Cost summary for today
    """
    today = datetime.now().strftime("%Y-%m-%d")
    today_start = f"{today}T00:00:00"
    today_end = f"{today}T23:59:59"
    return get_cost_for_date_range(sessions, today_start, today_end)


def get_this_week_cost(sessions: list[dict]) -> dict:
    """Get cost summary for the current week (Mon-Sun).

    Args:
        sessions: List of session dicts

    Returns:
        Cost summary for this week
    """
    today = datetime.now()
    # Monday of this week
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)

    start_date = monday.strftime("%Y-%m-%dT00:00:00")
    end_date = sunday.strftime("%Y-%m-%dT23:59:59")
    return get_cost_for_date_range(sessions, start_date, end_date)


def get_this_month_cost(sessions: list[dict]) -> dict:
    """Get cost summary for the current month.

    Args:
        sessions: List of session dicts

    Returns:
        Cost summary for this month
    """
    today = datetime.now()
    first_day = today.replace(day=1)

    # Last day of month
    if today.month == 12:
        last_day = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
    else:
        last_day = today.replace(month=today.month + 1, day=1) - timedelta(days=1)

    start_date = first_day.strftime("%Y-%m-%dT00:00:00")
    end_date = last_day.strftime("%Y-%m-%dT23:59:59")
    return get_cost_for_date_range(sessions, start_date, end_date)
