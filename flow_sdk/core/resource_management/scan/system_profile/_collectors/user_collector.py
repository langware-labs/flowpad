"""User collector - plugins, marketplaces, account, and user-level data."""

import json
from datetime import datetime
from pathlib import Path

from ..settings import (
    get_legacy_settings,
    get_user_settings,
)
from ..utils import (
    CLAUDE_HOME,
    CLAUDE_PROJECT,
    HOME,
    format_bytes,
    get_file_mtime,
    load_json,
    shorten_path,
)


def get_installed_plugins() -> list[dict]:
    """Get all installed plugins."""
    plugins = []
    data = load_json(CLAUDE_HOME / "plugins" / "installed_plugins.json")
    user_settings = get_user_settings() or {}
    enabled_plugins = user_settings.get("enabledPlugins", {})

    if data and "plugins" in data:
        for plugin_key, installs in data["plugins"].items():
            parts = plugin_key.split("@")
            name = parts[0]
            marketplace = parts[1] if len(parts) > 1 else "unknown"

            for install in installs:
                installed_at = install.get("installedAt", "")
                plugins.append(
                    {
                        "id": f"{name}@{marketplace}",
                        "type": "plugin",
                        "name": name,
                        "scope": install.get("scope", "user"),
                        "source_file": str(CLAUDE_HOME / "plugins" / "installed_plugins.json"),
                        "modified_at": installed_at,
                        "created_at": installed_at,
                        "path": install.get("installPath", ""),
                        "version": install.get("version", "unknown"),
                        "marketplace": marketplace,
                        "enabled": enabled_plugins.get(plugin_key, False),
                        "plugin_key": plugin_key,
                    }
                )
    return plugins


def get_known_marketplaces() -> list[dict]:
    """Get all known plugin marketplaces."""
    marketplaces = []
    data = load_json(CLAUDE_HOME / "plugins" / "known_marketplaces.json")

    if data:
        for name, info in data.items():
            source = info.get("source", {})
            last_updated = info.get("lastUpdated", "")
            marketplaces.append(
                {
                    "id": f"marketplace:{name}",
                    "type": "marketplace",
                    "name": name,
                    "scope": "user",
                    "source_file": str(CLAUDE_HOME / "plugins" / "known_marketplaces.json"),
                    "modified_at": last_updated,
                    "created_at": last_updated,
                    "source": source.get("source", "unknown"),
                    "repo": source.get("repo", ""),
                    "install_location": info.get("installLocation", ""),
                }
            )
    return marketplaces


def get_claude_md_files() -> list[dict]:
    """Get all CLAUDE.md instruction files."""
    files = []

    locations = [
        (CLAUDE_HOME / "CLAUDE.md", "global"),
        (Path.cwd() / "CLAUDE.md", "project"),
        (Path.cwd() / "CLAUDE.local.md", "local"),
        (CLAUDE_PROJECT / "CLAUDE.md", "project"),
    ]

    for path, scope in locations:
        if path.exists():
            stat = path.stat()
            files.append(
                {
                    "id": f"claude_md:{path}",
                    "type": "claude_md",
                    "name": path.name,
                    "scope": scope,
                    "source_file": str(path),
                    "path": str(path),
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "size": stat.st_size,
                }
            )

    return files


def get_account_info() -> dict:
    """Get OAuth account info from ~/.claude.json"""
    data = get_legacy_settings()
    if not data:
        return {
            "loggedIn": False,
            "email": "",
            "displayName": "",
            "organization": "",
            "role": "",
            "subscription": "",
            "source": "~/.claude.json",
        }

    account = data.get("oauthAccount")
    if not account:
        return {
            "loggedIn": False,
            "email": "",
            "displayName": "",
            "organization": "",
            "role": "",
            "subscription": "",
            "source": "~/.claude.json",
        }

    return {
        "loggedIn": True,
        "email": account.get("emailAddress", ""),
        "displayName": account.get("displayName", ""),
        "organization": account.get("organizationName", ""),
        "role": account.get("organizationRole", ""),
        "subscription": "Active" if data.get("hasAvailableSubscription", False) else "None",
        "source": "~/.claude.json",
    }


def get_github_repos() -> list[dict]:
    """Get GitHub repo path mappings from ~/.claude.json"""
    repos = []
    data = get_legacy_settings()
    if data and "githubRepoPaths" in data:
        for name, paths in data.get("githubRepoPaths", {}).items():
            repos.append(
                {
                    "id": f"github:{name}",
                    "type": "github_repo",
                    "name": name,
                    "scope": "user",
                    "source_file": str(HOME / ".claude.json"),
                    "modified_at": get_file_mtime(HOME / ".claude.json"),
                    "paths": [shorten_path(p) for p in paths] if isinstance(paths, list) else [shorten_path(paths)],
                }
            )
    return repos


def _build_slug_session_map() -> dict[str, list[dict]]:
    """Build a mapping of slug -> session info by scanning session transcripts.

    Returns dict where key is slug and value is list of {session_id, project_encoded_name}.
    Only reads first few lines of each file for performance.
    """
    slug_map: dict[str, list[dict]] = {}
    projects_dir = CLAUDE_HOME / "projects"

    if not projects_dir.exists():
        return slug_map

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue

        project_encoded_name = project_dir.name

        for jsonl_file in project_dir.glob("*.jsonl"):
            session_id = jsonl_file.stem
            slug = None

            # Read only first 10 lines to find slug (fast)
            try:
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for _ in range(10):
                        line = f.readline()
                        if not line:
                            break
                        try:
                            entry = json.loads(line)
                            if "slug" in entry:
                                slug = entry["slug"]
                                break
                        except json.JSONDecodeError:
                            continue
            except IOError:
                continue

            if slug:
                if slug not in slug_map:
                    slug_map[slug] = []
                slug_map[slug].append(
                    {
                        "session_id": session_id,
                        "project_encoded_name": project_encoded_name,
                    }
                )

    return slug_map


def _extract_plan_name(plan_file: Path, slug: str) -> str:
    """Read the first non-empty line of a plan file, stripping leading '#'."""
    try:
        for line in plan_file.read_text(encoding="utf-8").splitlines():
            stripped = line.lstrip("#").strip()
            if stripped:
                return stripped
    except OSError:
        pass
    return slug


def get_plans() -> list[dict]:
    """Get all saved plans with session/project correlation."""
    plans = []
    plans_dir = CLAUDE_HOME / "plans"

    if not plans_dir.exists():
        return plans

    # Build slug -> sessions mapping for correlation
    slug_session_map = _build_slug_session_map()

    for plan_file in plans_dir.glob("*.md"):
        stat = plan_file.stat()
        slug = plan_file.stem
        name = _extract_plan_name(plan_file, slug)

        # Get correlated sessions for this plan
        sessions = slug_session_map.get(slug, [])
        session_ids = [s["session_id"] for s in sessions]
        session_count = len(sessions)

        # Determine project from sessions (all sessions for a slug should be in same project)
        project_encoded_name = None
        if sessions:
            # Use the project from the first session (they should all be the same)
            project_encoded_name = sessions[0].get("project_encoded_name")

        plans.append(
            {
                "id": f"plan:{slug}",
                "type": "plan",
                "name": name,
                "scope": "user",
                "source_file": str(plan_file),
                "path": str(plan_file),
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "size": stat.st_size,
                "size_formatted": format_bytes(stat.st_size),
                # New correlation fields
                "slug": slug,
                "session_ids": session_ids,
                "session_count": session_count,
                "project_encoded_name": project_encoded_name,
            }
        )

    plans.sort(key=lambda x: x["modified_at"] or "", reverse=True)
    return plans


def get_directories() -> list[dict]:
    """Get directory structure info."""
    directories = []

    subdirs = [
        ("projects", "Session transcripts"),
        ("plugins", "Installed plugins"),
        ("skills", "Custom skills"),
        ("agents", "Custom subagents"),
        ("commands", "Global commands"),
        ("rules", "Global rules"),
        ("plans", "Saved plans"),
        ("todos", "Todo lists"),
        ("ide", "IDE connections"),
        ("session-env", "Session environments"),
        ("session-memory", "Memory config"),
        ("file-history", "File change history"),
        ("shell-snapshots", "Shell snapshots"),
        ("paste-cache", "Paste cache"),
        ("cache", "Cache data"),
        ("debug", "Debug logs"),
        ("telemetry", "Telemetry data"),
        ("statsig", "Feature flags"),
    ]

    for name, desc in subdirs:
        path = CLAUDE_HOME / name
        exists = path.exists()
        count = None

        if exists and path.is_dir():
            try:
                count = len(list(path.iterdir()))
            except (OSError, IOError):
                pass

        directories.append(
            {
                "id": f"dir:{name}",
                "type": "directory",
                "name": name,
                "scope": "user",
                "source_file": str(path),
                "path": str(path),
                "modified_at": get_file_mtime(path),
                "count": count,
                "description": desc,
                "exists": exists,
            }
        )

    return directories


def get_todos() -> list[dict]:
    """Get all todo files from ~/.claude/todos/ directory."""
    todos = []
    todos_dir = CLAUDE_HOME / "todos"

    if not todos_dir.exists():
        return todos

    for todo_file in todos_dir.glob("*.json"):
        try:
            filename = todo_file.stem
            if "-agent-" in filename:
                parts = filename.rsplit("-agent-", 1)
                session_id = parts[0]
                agent_id = parts[1] if len(parts) > 1 else session_id
                is_sub_agent = session_id != agent_id
            else:
                session_id = filename
                agent_id = filename
                is_sub_agent = False

            data = load_json(todo_file)
            entries = []
            if isinstance(data, list):
                entries = data
            elif isinstance(data, dict) and "todos" in data:
                entries = data.get("todos", [])

            completed_count = sum(1 for e in entries if e.get("status") == "completed")
            pending_count = sum(1 for e in entries if e.get("status") == "pending")
            in_progress_count = sum(1 for e in entries if e.get("status") == "in_progress")

            project_encoded_name = None
            projects_dir = CLAUDE_HOME / "projects"
            if projects_dir.exists():
                for project_dir in projects_dir.iterdir():
                    if not project_dir.is_dir():
                        continue
                    session_file = project_dir / f"{session_id}.jsonl"
                    if session_file.exists():
                        project_encoded_name = project_dir.name
                        break

            stat = todo_file.stat()
            todos.append(
                {
                    "id": f"todo:{filename}",
                    "type": "todo_file",
                    "name": filename,
                    "scope": "user",
                    "source_file": str(todo_file),
                    "path": str(todo_file),
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "is_sub_agent": is_sub_agent,
                    "project_encoded_name": project_encoded_name,
                    "entry_count": len(entries),
                    "completed_count": completed_count,
                    "pending_count": pending_count,
                    "in_progress_count": in_progress_count,
                    "entries": [
                        {
                            "content": e.get("content", ""),
                            "status": e.get("status", "pending"),
                            "activeForm": e.get("activeForm", ""),
                        }
                        for e in entries
                    ],
                }
            )
        except (OSError, IOError, json.JSONDecodeError):
            continue

    todos.sort(key=lambda x: x.get("modified_at") or "", reverse=True)
    return todos
