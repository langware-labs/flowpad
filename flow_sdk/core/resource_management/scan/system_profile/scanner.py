"""Scanner - main scan_full(), scan_item(), and scan_resources() functions."""

import hashlib
import json
import socket
from datetime import datetime
from pathlib import Path
from typing import Any

from ._collectors.config_collector import (
    get_agents,
    get_all_hooks,
    get_commands,
    get_mcp_servers,
    get_skills,
)
from ._collectors.cost_collector import (
    get_cost_overview,
    get_this_month_cost,
    get_this_week_cost,
    get_today_cost,
)
from ._collectors.project_collector import get_project_cwd, get_projects
from ._collectors.session_collector import (
    get_recent_sessions,
    get_session_info,
    get_session_info_quick,
)
from ._collectors.codex_project_collector import get_codex_projects
from ._collectors.codex_session_collector import (
    get_codex_session_info,
    get_codex_session_info_quick,
    get_recent_codex_sessions,
)
from ._collectors.transcript_collector import (
    get_ide_connections,
    get_recent_items,
)
from ._collectors.user_collector import (
    get_account_info,
    get_claude_md_files,
    get_directories,
    get_github_repos,
    get_installed_plugins,
    get_known_marketplaces,
    get_plans,
    get_todos,
)
from .settings import get_legacy_settings
from .utils import _claude_home, get_file_mtime, load_json

# ─────────────────────────────────────────────────────────────────
# Resource Type Constants
# ─────────────────────────────────────────────────────────────────

SYSTEM_RESOURCE_PREFIX = "system_resource_claude_"
_COST_OVERVIEW_CACHE_VERSION = 1
_COST_OVERVIEW_CACHE_DIRNAME = ".flowpad_scan_cache"


def get_system_resource_type(simple_name: str) -> str:
    """Convert simple name to full resource type with prefix."""
    return f"{SYSTEM_RESOURCE_PREFIX}{simple_name}"


def get_simple_resource_type(full_type: str) -> str:
    """Extract simple name from full resource type."""
    if full_type.startswith(SYSTEM_RESOURCE_PREFIX):
        return full_type[len(SYSTEM_RESOURCE_PREFIX) :]
    return full_type


def _build_summary(
    projects: list,
    sessions: list,
    hooks: list,
    mcp_servers: list,
    commands: list,
    agents: list,
    plugins: list,
    claude_md_files: list,
    github_repos: list,
    todos: list,
) -> dict:
    """Build summary in SystemProfileSummary format."""
    # Get legacy stats for additional counts
    legacy = get_legacy_settings() or {}
    total_prompts = legacy.get("numConversations", 0)
    startups = len(legacy.get("projects", {}))

    return {
        "totalProjects": len(projects),
        "totalSessions": len(sessions),
        "totalPrompts": total_prompts,
        "installedPlugins": len(plugins),
        "marketplaces": 0,  # Computed separately
        "mcpServers": len(mcp_servers),
        "customAgents": len(agents),
        "hooksConfigured": len(hooks),
        "claudeMdFiles": len(claude_md_files),
        "githubRepos": len(github_repos),
        "todoFiles": len(todos),
        "startups": startups,
        "currentDirectory": "",
    }


def _build_transcript_stats(sessions: list) -> dict:
    """Build transcript stats in TranscriptStats format."""
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_creation = 0
    total_messages = 0
    total_tool_uses = 0
    total_cost = 0.0
    all_models: dict[str, int] = {}
    all_tools: dict[str, int] = {}
    oldest_date = None
    newest_date = None

    for session in sessions:
        total_input += session.get("input_tokens") or 0
        total_output += session.get("output_tokens") or 0
        total_cache_read += session.get("cache_read_tokens") or 0
        total_cache_creation += session.get("cache_creation_tokens") or 0
        total_messages += session.get("message_count") or 0
        total_tool_uses += session.get("tool_uses") or 0
        total_cost += session.get("estimated_cost_usd") or 0.0

        for model in session.get("models_used") or []:
            all_models[model] = all_models.get(model, 0) + 1

        # Track date range
        created = session.get("created_at")
        if created:
            if not oldest_date or created < oldest_date:
                oldest_date = created
            if not newest_date or created > newest_date:
                newest_date = created

    primary_model = None
    if all_models:
        primary_model = max(all_models.items(), key=lambda x: x[1])[0]

    return {
        "sessions_analyzed": len(sessions),
        "total_entries": total_messages,
        "total_size_bytes": 0,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read_tokens": total_cache_read,
        "total_cache_creation_tokens": total_cache_creation,
        "total_estimated_cost_usd": total_cost,
        "cost_breakdown": {},
        "savings_from_cache_usd": 0.0,
        "models_used": all_models,
        "primary_model": primary_model,
        "tools_used": all_tools,
        "total_tool_uses": total_tool_uses,
        "entry_types": {},
        "content_types": {},
        "service_tiers": {},
        "oldest_session_date": oldest_date,
        "newest_session_date": newest_date,
    }


def scan_full(session_limit: int = 100, mode: str = "full") -> dict:
    """Run full system profile scan and return all data.

    Args:
        session_limit: Maximum sessions to analyze (0 = unlimited)
        mode: Scan mode - "full" or "quick"

    Returns:
        Dict matching SystemProfile model format
    """
    # Collect user data
    plugins = get_installed_plugins()
    marketplaces = get_known_marketplaces()
    account = get_account_info()
    github_repos = get_github_repos()
    claude_md_files = get_claude_md_files()
    directories = get_directories()
    plans = get_plans()
    todos = get_todos()

    # Collect config data
    hooks = get_all_hooks()
    mcp_servers = get_mcp_servers()
    commands = get_commands()
    agents = get_agents()
    skills = get_skills()

    # Collect project/session data — Claude + Codex merged with worker_type.
    claude_projects = get_projects()
    for p in claude_projects:
        p.setdefault("worker_type", "claude_code")
    codex_projects = get_codex_projects()
    projects = claude_projects + codex_projects
    projects.sort(key=lambda x: x.get("modified_at") or "", reverse=True)

    claude_sessions = get_recent_sessions(limit=session_limit, per_project_limit=0)
    for s in claude_sessions:
        s.setdefault("worker_type", "claude_code")
    codex_sessions = get_recent_codex_sessions(limit=session_limit, per_project_limit=0)
    sessions = claude_sessions + codex_sessions
    sessions.sort(key=lambda x: x.get("modified_at") or "", reverse=True)

    # Collect transcript stats
    ide_connections = get_ide_connections()

    # Build summary
    summary = _build_summary(
        projects,
        sessions,
        hooks,
        mcp_servers,
        commands,
        agents,
        plugins,
        claude_md_files,
        github_repos,
        todos,
    )
    summary["marketplaces"] = len(marketplaces)

    # Build transcript stats
    transcript_stats = _build_transcript_stats(sessions)

    # Build cost overview
    cost_overview = get_cost_overview(sessions)

    # Get recent items
    recent_items = get_recent_items(sessions, projects, plans, todos)

    # Get machine hostname
    try:
        machine = socket.gethostname()
    except Exception:
        machine = "unknown"

    return {
        "generated": datetime.now().isoformat(),
        "machine": machine,
        # Summary and account
        "summary": summary,
        "account": account,
        # Item lists (camelCase to match SystemProfile model)
        "directories": directories,
        "plugins": plugins,
        "marketplaces": marketplaces,
        "hooks": hooks,
        "mcpServers": mcp_servers,
        "agents": agents,
        "commands": commands,
        "claudeMdFiles": claude_md_files,
        "plans": plans,
        "projects": projects,
        "sessions": sessions,
        "githubRepos": github_repos,
        "skills": skills,
        "todos": todos,
        # Recent items
        "recentItems": recent_items,
        # IDE connections count
        "ideConnections": len(ide_connections),
        # Transcript stats
        "transcriptStats": transcript_stats,
        # Cost overview
        "costOverview": cost_overview,
    }


def scan_item(item_type: str, **kwargs) -> list | dict | None:
    """Scan a specific item type and return its data."""
    limit = kwargs.get("limit", 100)

    # Special handling for cost overview (requires sessions first)
    # Cost calculations need full session data (quick=False) to get token counts
    if item_type == "costOverview":
        signature = _build_cost_overview_signature(limit)
        cached = _load_cost_overview_cache(limit, signature)
        if cached is not None:
            return cached

        sessions = get_recent_sessions(limit=limit, per_project_limit=0, quick=False)
        overview = get_cost_overview(sessions)
        _save_cost_overview_cache(limit, signature, overview)
        return overview
    elif item_type == "costToday":
        sessions = get_recent_sessions(limit=limit, per_project_limit=0, quick=False)
        return get_today_cost(sessions)
    elif item_type == "costThisWeek":
        sessions = get_recent_sessions(limit=limit, per_project_limit=0, quick=False)
        return get_this_week_cost(sessions)
    elif item_type == "costThisMonth":
        sessions = get_recent_sessions(limit=limit, per_project_limit=0, quick=False)
        return get_this_month_cost(sessions)

    scanners = {
        "plugins": get_installed_plugins,
        "marketplaces": get_known_marketplaces,
        "account": get_account_info,
        "githubRepos": get_github_repos,
        "claudeMdFiles": get_claude_md_files,
        "directories": get_directories,
        "plans": get_plans,
        "todos": get_todos,
        "hooks": get_all_hooks,
        "mcpServers": get_mcp_servers,
        "commands": get_commands,
        "agents": get_agents,
        "skills": get_skills,
        "projects": get_projects,
        "sessions": lambda: get_recent_sessions(limit=limit, per_project_limit=0),
        "codexProjects": get_codex_projects,
        "codexSessions": lambda: get_recent_codex_sessions(limit=limit, per_project_limit=0),
        "ideConnections": get_ide_connections,
    }

    if item_type == "claudeUsage":
        from ._collectors.claude_usage_collector import get_claude_usage_sync

        return get_claude_usage_sync()

    if item_type == "claudeContext":
        from ._collectors.claude_context_collector import get_claude_context_sync

        session_id = kwargs.get("session_id")
        session_title: str | None = None
        if session_id:
            _sessions = get_recent_sessions(limit=200, per_project_limit=0)
            for _s in _sessions:
                if _s.get("session_id") == session_id or _s.get("id") == session_id:
                    session_title = _s.get("name") or _s.get("last_user_message")
                    break

        return get_claude_context_sync(session_id=session_id, session_title=session_title)

    if item_type not in scanners:
        return None

    return scanners[item_type]()


def _iter_session_file_stats() -> list[tuple[int, int, str, str]]:
    """Collect (mtime_ns, size_bytes, project_encoded_name, filename) for all sessions."""
    stats: list[tuple[int, int, str, str]] = []
    projects_dir = _claude_home() / "projects"

    if not projects_dir.exists():
        return stats

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue

        project_name = project_dir.name
        for session_file in project_dir.glob("*.jsonl"):
            try:
                file_stat = session_file.stat()
            except OSError:
                continue
            stats.append(
                (
                    file_stat.st_mtime_ns,
                    file_stat.st_size,
                    project_name,
                    session_file.name,
                )
            )

    return stats


def _build_cost_overview_signature(limit: int) -> dict[str, Any]:
    """Build a lightweight signature to detect session transcript changes."""
    stats = _iter_session_file_stats()
    # Keep ordering deterministic even when many files share the same mtime.
    stats.sort(key=lambda item: (-item[0], item[2], item[3], item[1]))

    if limit > 0:
        stats = stats[:limit]

    digest = hashlib.sha256()
    max_mtime_ns = 0

    for mtime_ns, size_bytes, project_name, file_name in stats:
        if mtime_ns > max_mtime_ns:
            max_mtime_ns = mtime_ns
        digest.update(
            f"{project_name}/{file_name}:{mtime_ns}:{size_bytes}|".encode("utf-8")
        )

    return {
        "version": _COST_OVERVIEW_CACHE_VERSION,
        "limit": limit,
        "session_count": len(stats),
        "max_mtime_ns": max_mtime_ns,
        "digest": digest.hexdigest(),
    }


def _get_cost_overview_cache_path(limit: int) -> Path:
    """Return cache file path for a cost overview limit bucket."""
    safe_limit = "all" if limit == 0 else str(limit)
    return (
        _claude_home() / _COST_OVERVIEW_CACHE_DIRNAME / f"cost_overview_{safe_limit}.json"
    )


def _load_cost_overview_cache(
    limit: int, signature: dict[str, Any]
) -> dict[str, Any] | None:
    """Load cached cost overview if signature matches current transcript state."""
    cache_path = _get_cost_overview_cache_path(limit)
    data = load_json(cache_path)
    if not isinstance(data, dict):
        return None

    if data.get("version") != _COST_OVERVIEW_CACHE_VERSION:
        return None

    if data.get("signature") != signature:
        return None

    payload = data.get("data")
    if isinstance(payload, dict):
        return payload

    return None


def _save_cost_overview_cache(
    limit: int, signature: dict[str, Any], overview: dict[str, Any]
) -> None:
    """Persist cost overview to disk for cross-request reuse."""
    cache_path = _get_cost_overview_cache_path(limit)

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": _COST_OVERVIEW_CACHE_VERSION,
            "cached_at": datetime.now().isoformat(),
            "signature": signature,
            "data": overview,
        }

        temp_path = cache_path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as cache_file:
            json.dump(payload, cache_file, ensure_ascii=True)
        temp_path.replace(cache_path)
    except (OSError, TypeError, ValueError):
        # Cache write failure should never break response generation.
        return


# ─────────────────────────────────────────────────────────────────
# Lazy Resource Scanning
# ─────────────────────────────────────────────────────────────────

# Collector mapping (using simple names internally, API uses full types)
# Note: session collector uses quick=True for fast listing (file metadata only).
# Use get_session_info() directly if full token/cost data is needed.
_COLLECTORS: dict[str, Any] = {
    "plugin": get_installed_plugins,
    "marketplace": get_known_marketplaces,
    "hook": get_all_hooks,
    "mcp_server": get_mcp_servers,
    "command": get_commands,
    "agent": get_agents,
    "skill": get_skills,
    "project": get_projects,
    "claude_session": lambda: get_recent_sessions(limit=0, per_project_limit=0, quick=True),
    "codex_project": get_codex_projects,
    "codex_session": lambda: get_recent_codex_sessions(limit=0, per_project_limit=0, quick=True),
    "plan": get_plans,
    "todo_file": get_todos,
    "claude_md": get_claude_md_files,
    "directory": get_directories,
    "github_repo": get_github_repos,
    "ide_connection": get_ide_connections,
}

# Full type mapping for API (with prefix)
COLLECTORS: dict[str, Any] = {
    get_system_resource_type(k): v for k, v in _COLLECTORS.items()
}
# Also support simple names for backwards compatibility
COLLECTORS.update(_COLLECTORS)

# Parent key mapping for child resources (sessions belong to projects, todos to sessions)
PARENT_KEY_MAP: dict[str, str] = {
    get_system_resource_type("claude_session"): "project_encoded_name",
    get_system_resource_type("codex_session"): "project_id",
    get_system_resource_type("todo_file"): "session_id",
    # Also support simple names
    "claude_session": "project_encoded_name",
    "codex_session": "project_id",
    "todo_file": "session_id",
}


def _in_time_window(
    modified_at: str | None, start: str | None, end: str | None
) -> bool:
    """Check if a modified_at timestamp falls within the time window."""
    if not modified_at:
        return False
    if start and modified_at < start:
        return False
    if end and modified_at > end:
        return False
    return True


def _compute_scanned_window(items: list[dict], time_window: dict | None) -> dict:
    """Compute the actual scanned time window from items."""
    if not items:
        return time_window or {}

    # Get min/max modified_at from items
    modified_times = [i.get("modified_at") for i in items if i.get("modified_at")]
    if not modified_times:
        return time_window or {}

    actual_start = min(modified_times)
    actual_end = max(modified_times)

    # If time_window was specified, use its bounds as limits
    if time_window:
        if time_window.get("start") and time_window["start"] > actual_start:
            actual_start = time_window["start"]
        if time_window.get("end") and time_window["end"] < actual_end:
            actual_end = time_window["end"]

    return {"start": actual_start, "end": actual_end}


def _add_resource_type_to_items(items: list[dict], resource_type: str) -> list[dict]:
    """Add the full resource type to each item."""
    # Ensure we use the full prefixed type
    full_type = (
        resource_type
        if resource_type.startswith(SYSTEM_RESOURCE_PREFIX)
        else get_system_resource_type(resource_type)
    )
    for item in items:
        item["resource_type"] = full_type
    return items


def scan_resources(
    resource_type: str,
    time_window: dict | None = None,
    parent_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """Scan specific resource type with filtering.

    Args:
        resource_type: Resource type (e.g., 'hook', 'mcp_server', 'session', or full prefix like 'system_resource_claude_hook')
        time_window: {"start": "2024-01-01T00:00:00", "end": "2024-01-02T00:00:00"}
        parent_id: For child resources (sessions→project_encoded_name, todos→session_id)
        limit: Max items to return (default 100)
        offset: Pagination offset (default 0)

    Returns:
        {
            "items": [...],
            "scanned_window": {"start": ISO, "end": ISO},
            "total_count": int,
            "has_more": bool,
            "resource_type": str  # Full prefixed type
        }
    """
    simple_type = get_simple_resource_type(resource_type)
    full_type = get_system_resource_type(simple_type)

    # Special optimized path for sessions: quick scan first, then enrich only returned items
    if simple_type == "claude_session":
        return _scan_sessions_optimized(
            resource_type=resource_type,
            time_window=time_window,
            parent_id=parent_id,
            limit=limit,
            offset=offset,
        )

    # Get collector function for type (supports both simple and full types)
    collector = COLLECTORS.get(resource_type)
    if not collector:
        return {
            "items": [],
            "error": f"Unknown type: {resource_type}",
            "resource_type": resource_type,
        }

    # Collect all items of type
    try:
        all_items = collector()
    except Exception as e:
        return {
            "items": [],
            "error": f"Collection error: {str(e)}",
            "resource_type": resource_type,
        }

    # Handle non-list returns (e.g., account info, ide_connections count)
    if not isinstance(all_items, list):
        # Wrap single items or counts in a list
        if isinstance(all_items, dict):
            all_items = [all_items]
        elif isinstance(all_items, int):
            # IDE connections returns a count
            all_items = [
                {"id": "ide_connections", "count": all_items, "type": "ide_connection"}
            ]
        else:
            all_items = []

    # Add resource_type to each item
    all_items = _add_resource_type_to_items(all_items, simple_type)

    # Filter by time window
    if time_window:
        start = time_window.get("start")
        end = time_window.get("end")
        all_items = [
            item
            for item in all_items
            if _in_time_window(item.get("modified_at"), start, end)
        ]

    # Filter by parent
    if parent_id:
        parent_key = PARENT_KEY_MAP.get(resource_type) or PARENT_KEY_MAP.get(
            simple_type
        )
        if parent_key:
            all_items = [
                item for item in all_items if item.get(parent_key) == parent_id
            ]

    # Sort by modified_at DESC (most recent first)
    all_items.sort(key=lambda x: x.get("modified_at") or "", reverse=True)

    # Paginate
    total_count = len(all_items)
    items = all_items[offset : offset + limit]
    has_more = offset + limit < total_count

    # Determine actual scanned window
    scanned_window = _compute_scanned_window(items, time_window)

    return {
        "items": items,
        "scanned_window": scanned_window,
        "total_count": total_count,
        "has_more": has_more,
        "resource_type": full_type,
    }


def _scan_sessions_optimized(
    resource_type: str,
    time_window: dict | None = None,
    parent_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """Optimized session scanning: quick scan all, then enrich only returned items.

    This avoids parsing thousands of JSONL files - we only parse the ones we'll return.
    """
    from pathlib import Path

    simple_type = get_simple_resource_type(resource_type)
    full_type = get_system_resource_type(simple_type)

    # Step 1: Quick scan all sessions (just file metadata, very fast)
    all_items = get_recent_sessions(limit=0, per_project_limit=0, quick=True)

    # Add resource_type to each item
    all_items = _add_resource_type_to_items(all_items, simple_type)

    # Filter by time window
    if time_window:
        start = time_window.get("start")
        end = time_window.get("end")
        all_items = [
            item
            for item in all_items
            if _in_time_window(item.get("modified_at"), start, end)
        ]

    # Filter by parent
    if parent_id:
        parent_key = PARENT_KEY_MAP.get(resource_type) or PARENT_KEY_MAP.get(
            simple_type
        )
        if parent_key:
            all_items = [
                item for item in all_items if item.get(parent_key) == parent_id
            ]

    # Sort by modified_at DESC (most recent first)
    all_items.sort(key=lambda x: x.get("modified_at") or "", reverse=True)

    # Paginate
    total_count = len(all_items)
    items = all_items[offset : offset + limit]
    has_more = offset + limit < total_count

    # Step 2: Enrich only the returned items with full data (parse JSONL files)
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

    enriched_items = []
    for item in items:
        source_file = item.get("source_file") or item.get("path")
        if source_file:
            try:
                record = ClaudeSessionRecord.from_jsonl(
                    Path(source_file),
                    project_encoded_name=item.get("project_encoded_name"),
                )
                d = record.meta_dict()
                d["resource_type"] = full_type
                enriched_items.append(d)
            except Exception:
                # Fallback to quick data if full parse fails
                enriched_items.append(item)
        else:
            enriched_items.append(item)

    # Determine actual scanned window
    scanned_window = _compute_scanned_window(enriched_items, time_window)

    return {
        "items": enriched_items,
        "scanned_window": scanned_window,
        "total_count": total_count,
        "has_more": has_more,
        "resource_type": full_type,
    }


def get_resource_summary() -> dict:
    """Get quick counts per resource type without full scan."""
    summary = {}
    for simple_name in _COLLECTORS:
        full_type = get_system_resource_type(simple_name)
        try:
            collector = _COLLECTORS[simple_name]
            items = collector()
            if isinstance(items, list):
                summary[full_type] = len(items)
            elif isinstance(items, int):
                summary[full_type] = items
            elif isinstance(items, dict):
                summary[full_type] = 1
            else:
                summary[full_type] = 0
        except Exception:
            summary[full_type] = 0
    return summary


# ─────────────────────────────────────────────────────────────────
# Per-Project Scanning (Fast Path)
# ─────────────────────────────────────────────────────────────────


def build_scope(scope_type: str, project_encoded_name: str | None = None) -> list[str]:
    """Build scope array for a resource."""
    if scope_type == "user":
        return ["user"]
    elif scope_type == "project" and project_encoded_name:
        return [f"project:{project_encoded_name}"]
    elif scope_type == "local" and project_encoded_name:
        return [f"project:{project_encoded_name}", "local"]
    elif scope_type == "legacy":
        return ["user", "legacy"]
    return [scope_type]


def get_sessions_for_project(
    project_dir: Path, project_encoded_name: str, limit: int = 0, quick: bool = True
) -> list[dict]:
    """Get sessions for a specific project only.

    Args:
        project_dir: Path to the project directory
        project_encoded_name: The encoded project directory name
        limit: Maximum number of sessions to return (0 = unlimited)
        quick: Ignored — always uses ClaudeSessionRecord.from_jsonl() for a
            unified ClaudeSessionRecord.to_dict() format.
    """
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord

    sessions = []
    for jsonl_file in sorted(
        project_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True
    ):
        if limit > 0 and len(sessions) >= limit:
            break
        try:
            record = ClaudeSessionRecord.from_jsonl(
                jsonl_file, project_encoded_name=project_encoded_name
            )
            d = record.meta_dict()
            # Skip empty/broken sessions with no conversation content
            if not (
                d.get("message_count")
                or d.get("assistant_message_count")
                or d.get("user_message_count")
            ):
                continue
            d["scope"] = build_scope("project", project_encoded_name)
            d["type"] = get_system_resource_type("claude_session")
            sessions.append(d)
        except Exception:
            continue
    return sessions


def get_hooks_for_project(claude_dir: Path, project_encoded_name: str) -> list[dict]:
    """Get hooks from a project's .claude folder."""
    import hashlib

    hooks = []
    scope = build_scope("project", project_encoded_name)

    for settings_file in ["settings.json", "settings.local.json"]:
        settings_path = claude_dir / settings_file
        if not settings_path.exists():
            continue

        data = load_json(settings_path)
        if not data or "hooks" not in data:
            continue

        file_scope = (
            scope
            if settings_file == "settings.json"
            else build_scope("local", project_encoded_name)
        )

        for event_type, hook_list in data["hooks"].items():
            if isinstance(hook_list, list):
                for hook_entry in hook_list:
                    matcher = hook_entry.get("matcher", "*")
                    for h in hook_entry.get("hooks", []):
                        command = h.get("command", "")
                        hook_type = h.get("type", "command")
                        matcher_hash = hashlib.md5(
                            f"{matcher}:{command}".encode()
                        ).hexdigest()[:8]
                        hooks.append(
                            {
                                "id": f"project:{event_type}:{matcher_hash}",
                                "type": get_system_resource_type("hook"),
                                "name": f"{event_type} ({matcher})",
                                "scope": file_scope,
                                "source_file": str(settings_path),
                                "modified_at": get_file_mtime(settings_path),
                                "event_type": event_type,
                                "matcher": matcher,
                                "command": command,
                                "hook_type": hook_type,
                            }
                        )
    return hooks


def get_mcp_for_project(project_path: Path, project_encoded_name: str) -> list[dict]:
    """Get MCP servers for a specific project."""
    servers = []
    scope = build_scope("project", project_encoded_name)

    for mcp_file in [project_path / ".mcp.json", project_path / ".claude" / "mcp.json"]:
        if not mcp_file.exists():
            continue
        data = load_json(mcp_file)
        if data and "mcpServers" in data:
            for name, config in data["mcpServers"].items():
                servers.append(
                    {
                        "id": f"{mcp_file}:{name}",
                        "type": get_system_resource_type("mcp_server"),
                        "name": name,
                        "scope": scope,
                        "source_file": str(mcp_file),
                        "modified_at": get_file_mtime(mcp_file),
                        "command": config.get("command", ""),
                        "args": config.get("args", []),
                        "env": config.get("env", {}),
                    }
                )
    return servers


def get_commands_for_project(claude_dir: Path, project_encoded_name: str) -> list[dict]:
    """Get commands from a project's .claude/commands folder."""
    commands = []
    scope = build_scope("project", project_encoded_name)
    commands_dir = claude_dir / "commands"

    if commands_dir.exists():
        for f in commands_dir.glob("*.md"):
            commands.append(
                {
                    "id": f"project:{f.stem}:{claude_dir}",
                    "type": get_system_resource_type("command"),
                    "name": f.stem,
                    "scope": scope,
                    "source_file": str(f),
                    "path": str(f),
                    "modified_at": get_file_mtime(f),
                }
            )
    return commands


def get_agents_for_project(claude_dir: Path, project_encoded_name: str) -> list[dict]:
    """Get agents from a project's .claude/agents folder."""
    agents = []
    scope = build_scope("project", project_encoded_name)
    agents_dir = claude_dir / "agents"

    if agents_dir.exists():
        for f in agents_dir.glob("*.md"):
            agents.append(
                {
                    "id": f"project:{f.stem}:{claude_dir}",
                    "type": get_system_resource_type("agent"),
                    "name": f.stem,
                    "scope": scope,
                    "source_file": str(f),
                    "path": str(f),
                    "modified_at": get_file_mtime(f),
                }
            )
    return agents


def get_skills_for_project(claude_dir: Path, project_encoded_name: str) -> list[dict]:
    """Get skills from a project's .claude/skills folder."""
    skills = []
    scope = build_scope("project", project_encoded_name)
    skills_dir = claude_dir / "skills"

    if skills_dir.exists():
        for item in skills_dir.iterdir():
            if not item.is_dir() or item.name.startswith("."):
                continue
            skills.append(
                {
                    "id": f"skill:{item.name}:{claude_dir}",
                    "type": get_system_resource_type("skill"),
                    "name": item.name,
                    "scope": scope,
                    "source_file": str(item),
                    "path": str(item),
                    "modified_at": get_file_mtime(item),
                    "usage_count": 0,
                }
            )
    return skills


def get_claude_md_for_project(
    project_path: Path, project_encoded_name: str
) -> list[dict]:
    """Get CLAUDE.md files for a specific project."""
    files = []
    scope = build_scope("project", project_encoded_name)

    for md_file in [
        project_path / "CLAUDE.md",
        project_path / "CLAUDE.local.md",
        project_path / ".claude" / "CLAUDE.md",
    ]:
        if md_file.exists():
            files.append(
                {
                    "id": f"claude_md:{md_file}",
                    "type": get_system_resource_type("claude_md"),
                    "name": md_file.name,
                    "scope": scope,
                    "source_file": str(md_file),
                    "path": str(md_file),
                    "modified_at": get_file_mtime(md_file),
                    "size_bytes": md_file.stat().st_size,
                }
            )
    return files


def get_todos_for_project(project_encoded_name: str) -> list[dict]:
    """Get todos linked to this project's sessions."""
    todos = []
    todos_dir = _claude_home() / "todos"
    project_sessions_dir = _claude_home() / "projects" / project_encoded_name

    if not todos_dir.exists() or not project_sessions_dir.exists():
        return todos

    project_session_ids = {f.stem for f in project_sessions_dir.glob("*.jsonl")}

    for todo_file in todos_dir.glob("*.json"):
        if todo_file.stem in project_session_ids:
            data = load_json(todo_file)
            if data:
                todos.append(
                    {
                        "id": f"todo:{todo_file.stem}",
                        "type": get_system_resource_type("todo_file"),
                        "name": todo_file.stem,
                        "scope": build_scope("project", project_encoded_name)
                        + [f"session:{todo_file.stem}"],
                        "source_file": str(todo_file),
                        "modified_at": get_file_mtime(todo_file),
                        "task_count": len(data.get("tasks", [])),
                    }
                )
    return todos


def scan_project(
    project_encoded_name: str, session_limit: int = 100, include_sessions: bool = True
) -> dict:
    """
    Scan all resources for a specific project.

    This is the FAST PATH - only scans one project's resources,
    not all projects.

    Args:
        project_encoded_name: The encoded project directory name
        session_limit: Maximum sessions to scan (default 100, 0 = unlimited)

    Returns:
        Dict with all resource types for this project
    """
    project_dir = _claude_home() / "projects" / project_encoded_name
    if not project_dir.exists():
        return {"error": f"Project not found: {project_encoded_name}"}

    project_cwd = get_project_cwd(project_dir)

    result = {
        "project_encoded_name": project_encoded_name,
        "project_cwd": project_cwd,
        "scanned_at": datetime.now().isoformat(),
    }

    # Sessions for this project only (with limit) - optional for faster resource-only scans
    if include_sessions:
        result["sessions"] = get_sessions_for_project(
            project_dir, project_encoded_name, limit=session_limit
        )
    else:
        result["sessions"] = []

    # Fast count of total sessions (just file count, no parsing)
    result["total_session_count"] = len(list(project_dir.glob("*.jsonl")))

    # Config from project's .claude folder only
    if project_cwd:
        project_path = Path(project_cwd)
        claude_dir = project_path / ".claude"

        result["hooks"] = get_hooks_for_project(claude_dir, project_encoded_name)
        result["mcp_servers"] = get_mcp_for_project(project_path, project_encoded_name)
        result["commands"] = get_commands_for_project(claude_dir, project_encoded_name)
        result["agents"] = get_agents_for_project(claude_dir, project_encoded_name)
        result["skills"] = get_skills_for_project(claude_dir, project_encoded_name)
        result["claude_md"] = get_claude_md_for_project(
            project_path, project_encoded_name
        )
    else:
        result["hooks"] = []
        result["mcp_servers"] = []
        result["commands"] = []
        result["agents"] = []
        result["skills"] = []
        result["claude_md"] = []

    # Todos linked to this project's sessions
    result["todos"] = get_todos_for_project(project_encoded_name)

    # Summary counts
    result["summary"] = {
        "sessions": len(result["sessions"]),
        "hooks": len(result["hooks"]),
        "mcp_servers": len(result["mcp_servers"]),
        "commands": len(result["commands"]),
        "agents": len(result["agents"]),
        "skills": len(result["skills"]),
        "claude_md": len(result["claude_md"]),
        "todos": len(result["todos"]),
    }

    return result

