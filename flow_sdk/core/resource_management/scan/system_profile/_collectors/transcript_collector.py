"""Transcript collector - history stats, IDE connections, aggregated stats."""

from pathlib import Path

from ..settings import (
    get_legacy_settings,
)
from ..utils import (
    CLAUDE_HOME,
    count_lines,
    get_file_mtime,
    load_json,
)


def get_history_stats() -> dict:
    """Get file change history stats."""
    history_dir = CLAUDE_HOME / "file-history"
    if not history_dir.exists():
        return {"total_files": 0, "total_changes": 0}

    total_changes = 0
    for f in history_dir.iterdir():
        if f.is_file():
            total_changes += count_lines(f)

    return {
        "total_files": len(list(history_dir.iterdir())),
        "total_changes": total_changes,
    }


def get_ide_connections() -> list[dict]:
    """Get IDE connection files from ~/.claude/ide/."""
    connections = []
    ide_dir = CLAUDE_HOME / "ide"
    if not ide_dir.exists():
        return connections

    for f in ide_dir.glob("*.json"):
        data = load_json(f)
        if data:
            connections.append(
                {
                    "id": f"ide:{f.stem}",
                    "type": "ide_connection",
                    "name": data.get("name", f.stem),
                    "scope": "user",
                    "source_file": str(f),
                    "path": str(f),
                    "modified_at": get_file_mtime(f),
                    "version": data.get("version", ""),
                    "transport": data.get("transport", ""),
                }
            )
    return connections


def get_legacy_stats() -> dict:
    """Get aggregated statistics from ~/.claude.json."""
    data = get_legacy_settings()
    if not data:
        return {}

    stats = {}
    if projects := data.get("projects"):
        stats["known_projects_count"] = len(projects)
        stats["projects_with_instructions"] = sum(1 for p in projects.values() if p.get("hasInstructions"))
        stats["projects_with_mcp"] = sum(1 for p in projects.values() if p.get("hasMcpServers"))

    if num_convs := data.get("numConversations"):
        stats["total_conversations"] = num_convs
    if num_valid := data.get("numValidConversations"):
        stats["valid_conversations"] = num_valid

    return stats


def get_summary(
    projects: list,
    sessions: list,
    hooks: list,
    mcp_servers: list,
    commands: list,
    agents: list,
    skills: list,
    plugins: list,
) -> dict:
    """Get summary statistics."""
    return {
        "projects": len(projects),
        "sessions": len(sessions),
        "hooks": len(hooks),
        "mcp_servers": len(mcp_servers),
        "commands": len(commands),
        "agents": len(agents),
        "skills": len(skills),
        "plugins": len(plugins),
    }


def get_transcript_stats(sessions: list) -> dict:
    """Get aggregated transcript statistics across sessions."""
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_creation = 0
    total_messages = 0
    total_tool_uses = 0
    total_cost = 0.0
    all_models = {}

    for session in sessions:
        total_input += session.get("input_tokens", 0)
        total_output += session.get("output_tokens", 0)
        total_cache_read += session.get("cache_read_tokens", 0)
        total_cache_creation += session.get("cache_creation_tokens", 0)
        total_messages += session.get("message_count", 0)
        total_tool_uses += session.get("tool_uses", 0)
        total_cost += session.get("estimated_cost_usd", 0.0)

        for model in session.get("models_used", []):
            all_models[model] = all_models.get(model, 0) + 1

    return {
        "total_sessions": len(sessions),
        "total_messages": total_messages,
        "total_tool_uses": total_tool_uses,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read_tokens": total_cache_read,
        "total_cache_creation_tokens": total_cache_creation,
        "total_estimated_cost_usd": total_cost,
        "models_used": all_models,
        "most_used_model": max(all_models.items(), key=lambda x: x[1])[0] if all_models else None,
    }


def get_recent_items(
    sessions: list,
    projects: list,
    plans: list,
    todos: list,
    limit: int = 20,
) -> list[dict]:
    """Get most recently modified items across all types.

    Returns items matching SystemProfileItem schema with:
    - system_id: Unique identifier
    - item_type: Type discriminator
    - name: Display name
    - scope: Location scope
    - modified_at: Last modified timestamp
    - path: Full path to item
    """
    items = []

    for session in sessions[:10]:
        items.append(
            {
                "id": session.get("system_id", session.get("name", "")),
                "type": "claude_session",
                "name": session.get("name", ""),
                "scope": session.get("scope", "user"),
                "modified_at": session.get("modified_at"),
                "path": session.get("path", ""),
            }
        )

    for project in projects[:5]:
        items.append(
            {
                "id": project.get("system_id", project.get("name", "")),
                "type": "project",
                "name": project.get("name", ""),
                "scope": project.get("scope", "user"),
                "modified_at": project.get("modified_at"),
                "path": project.get("cwd", ""),
            }
        )

    for plan in plans[:3]:
        items.append(
            {
                "id": plan.get("system_id", plan.get("name", "")),
                "type": "plan",
                "name": plan.get("name", ""),
                "scope": plan.get("scope", "user"),
                "modified_at": plan.get("modified_at"),
                "path": plan.get("path", ""),
            }
        )

    for todo in todos[:3]:
        items.append(
            {
                "id": todo.get("system_id", todo.get("name", "")),
                "type": "todo",
                "name": todo.get("name", ""),
                "scope": todo.get("scope", "user"),
                "modified_at": todo.get("modified_at"),
                "path": todo.get("path", ""),
            }
        )

    items.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
    return items[:limit]
