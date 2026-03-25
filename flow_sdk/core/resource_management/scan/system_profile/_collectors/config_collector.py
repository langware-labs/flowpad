"""Config collector - hooks, MCP servers, commands, agents, skills."""

import hashlib
from pathlib import Path

from .project_collector import (
    get_project_cwd,
)
from ..settings import (
    get_legacy_settings,
)
from ..utils import (
    CLAUDE_HOME,
    HOME,
    get_file_mtime,
    load_json,
)

try:
    from flow_sdk.core.resource_management.agent.claude import (  # type: ignore[import-not-found]
        AgentResource,
        CommandResource,
        HookResource,
        McpServerResource,
        SkillResource,
    )

    _RESOURCE_MGMT_AVAILABLE = True
except Exception:
    _RESOURCE_MGMT_AVAILABLE = False


def _fs_entities_to_items(entities: list) -> list[dict]:
    items: list[dict] = []
    for entity in entities:
        try:
            items.append(entity.model_dump(mode="json"))
        except Exception:
            continue
    return items


def _merge_items(primary: list[dict], secondary: list[dict]) -> list[dict]:
    seen = {item.get("id") for item in primary if item.get("id") is not None}
    for item in secondary:
        item_id = item.get("id")
        if item_id is None or item_id not in seen:
            primary.append(item)
            if item_id is not None:
                seen.add(item_id)
    return primary


def get_hooks_from_settings(settings: dict, scope: str, source_file: str) -> list[dict]:
    """Extract hooks from a settings dict."""
    hooks = []
    if not settings or "hooks" not in settings:
        return hooks

    for event_type, hook_list in settings["hooks"].items():
        if isinstance(hook_list, list):
            for hook_entry in hook_list:
                matcher = hook_entry.get("matcher", "*")
                for h in hook_entry.get("hooks", []):
                    command = h.get("command", "")
                    hook_type = h.get("type", "command")

                    # Extract flow_metadata if present
                    fm = h.get("flow_metadata")
                    flow_metadata_name = None
                    flowpad_hook_id = None
                    if fm and isinstance(fm, dict):
                        flow_metadata_name = fm.get("name")
                        flowpad_hook_id = fm.get("flowpad_hook_id")

                    # Use flowpad_hook_id as ID when available, otherwise fall back to MD5 hash.
                    # Managed hooks omit scope from ID so _merge_items deduplicates across scan paths
                    # (the same user settings.json can be reached from both user and project scans).
                    if flowpad_hook_id:
                        hook_id = f"managed:{event_type}:{flowpad_hook_id}"
                    else:
                        matcher_hash = hashlib.md5(f"{matcher}:{command}".encode()).hexdigest()[:8]
                        hook_id = f"{scope}:{event_type}:{matcher_hash}"

                    hook_item: dict = {
                        "id": hook_id,
                        "type": "hook",
                        "name": flow_metadata_name or f"{event_type} ({matcher})",
                        "scope": scope,
                        "source_file": source_file,
                        "path": source_file,
                        "modified_at": get_file_mtime(Path(source_file)),
                        "event_type": event_type,
                        "matcher": matcher,
                        "command": command,
                        "hook_type": hook_type,
                    }
                    if flow_metadata_name:
                        hook_item["flow_metadata_name"] = flow_metadata_name
                    if flowpad_hook_id:
                        hook_item["flowpad_hook_id"] = flowpad_hook_id
                    hooks.append(hook_item)
    return hooks


def get_hooks_from_folder(folder: Path, scope: str, seen_files: set[str] | None = None) -> list[dict]:
    """Get hooks from settings files in a folder.

    Args:
        seen_files: Optional set of resolved file paths already scanned.
                    When provided, files already in the set are skipped to avoid duplicates.
    """
    hooks = []
    settings_path = folder / "settings.json"
    if settings_path.exists():
        resolved = str(settings_path.resolve())
        if seen_files is not None and resolved in seen_files:
            pass  # Already scanned from another scope
        else:
            if seen_files is not None:
                seen_files.add(resolved)
            data = load_json(settings_path)
            if data:
                hooks.extend(get_hooks_from_settings(data, scope, str(settings_path)))

    local_path = folder / "settings.local.json"
    if local_path.exists():
        resolved = str(local_path.resolve())
        if seen_files is not None and resolved in seen_files:
            pass  # Already scanned from another scope
        else:
            if seen_files is not None:
                seen_files.add(resolved)
            data = load_json(local_path)
            if data:
                hooks.extend(get_hooks_from_settings(data, "local", str(local_path)))
    return hooks


def _resolve_plugin_root(command: str, install_path: str) -> str:
    """Replace $CLAUDE_PLUGIN_ROOT / ${CLAUDE_PLUGIN_ROOT} with the actual install path."""
    command = command.replace("${CLAUDE_PLUGIN_ROOT}", install_path)
    command = command.replace("$CLAUDE_PLUGIN_ROOT", install_path)
    return command


def get_hooks_from_plugins() -> list[dict]:
    """Get hooks defined by installed Claude Code plugins.

    Registry format (version 2):
    {
      "version": 2,
      "plugins": {
        "name@marketplace": [{ "installPath": "...", ... }]
      }
    }
    """
    hooks: list[dict] = []
    registry_path = CLAUDE_HOME / "plugins" / "installed_plugins.json"
    if not registry_path.exists():
        return hooks

    registry = load_json(registry_path)
    if not registry or not isinstance(registry, dict):
        return hooks

    plugins_map = registry.get("plugins", {})
    if not isinstance(plugins_map, dict):
        return hooks

    for plugin_key, entries in plugins_map.items():
        # plugin_key is "name@marketplace", extract the name part
        plugin_name = plugin_key.split("@")[0] if "@" in plugin_key else plugin_key

        if not isinstance(entries, list):
            continue

        for plugin_entry in entries:
            install_path = plugin_entry.get("installPath", "")
            if not install_path:
                continue

            hooks_file = Path(install_path) / "hooks" / "hooks.json"
            if not hooks_file.exists():
                continue

            hooks_data = load_json(hooks_file)
            if not hooks_data:
                continue

            raw_hooks = get_hooks_from_settings(hooks_data, "plugin", str(hooks_file))
            for h in raw_hooks:
                # Resolve $CLAUDE_PLUGIN_ROOT in commands
                h["command"] = _resolve_plugin_root(h["command"], install_path)
                # Override ID to include plugin name
                matcher_cmd = f"{h['matcher']}:{h['command']}"
                h["id"] = f"plugin:{plugin_name}:{h['event_type']}:{hashlib.md5(matcher_cmd.encode()).hexdigest()[:8]}"
                h["plugin_name"] = plugin_name
            hooks.extend(raw_hooks)

    return hooks


def _record_to_hook_item(rec: object) -> dict:
    """Convert a ClaudeHookRecord to the dict format expected by the scanner."""
    scope = getattr(rec, "scope", "user")
    scope_val = scope.value if hasattr(scope, "value") else str(scope)
    sf = getattr(rec, "source_file", "") or ""

    item: dict = {
        "id": rec.id,  # type: ignore[attr-defined]
        "type": "hook",
        "name": rec.name,  # type: ignore[attr-defined]
        "scope": scope_val,
        "source_file": sf,
        "path": sf,
        "modified_at": get_file_mtime(Path(sf)) if sf else None,
        "event_type": rec.event_type,  # type: ignore[attr-defined]
        "matcher": rec.matcher,  # type: ignore[attr-defined]
        "command": rec.command,  # type: ignore[attr-defined]
        "hook_type": rec.hook_type,  # type: ignore[attr-defined]
    }
    fm_name = getattr(rec, "flow_metadata_name", None)
    fp_id = getattr(rec, "flowpad_hook_id", None)
    pn = getattr(rec, "plugin_name", None)
    if fm_name:
        item["flow_metadata_name"] = fm_name
    if fp_id:
        item["flowpad_hook_id"] = fp_id
    if pn:
        item["plugin_name"] = pn
    return item


def get_all_hooks() -> list[dict]:
    """Get all hooks from user, plugins, and all projects.

    Delegates to ClaudeHookRecord.discover() which scans the same settings
    files (user, project, local, plugin, legacy) with overlay support.
    Falls back to manual scanning if ClaudeHookRecord is unavailable.
    """
    try:
        from flow_sdk.fs_records.claude.claude_hook_record import ClaudeHookRecord
        records = ClaudeHookRecord.discover()
        return [_record_to_hook_item(r) for r in records]
    except Exception:
        return _get_all_hooks_fallback()


def _get_all_hooks_fallback() -> list[dict]:
    """Legacy fallback: manual settings.json parsing."""
    all_hooks: list[dict] = []
    seen_files: set[str] = set()

    _merge_items(all_hooks, get_hooks_from_folder(CLAUDE_HOME, "user", seen_files))
    _merge_items(all_hooks, get_hooks_from_plugins())

    legacy_path = HOME / ".claude.json"
    if legacy_path.exists():
        data = load_json(legacy_path)
        if data:
            _merge_items(all_hooks, get_hooks_from_settings(data, "legacy", str(legacy_path)))

    projects_dir = CLAUDE_HOME / "projects"
    if projects_dir.exists():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cwd = get_project_cwd(project_dir)
            if not cwd:
                continue
            project_path = Path(cwd)
            if not project_path.exists():
                continue

            _merge_items(all_hooks, get_hooks_from_folder(project_path / ".claude", "project", seen_files))

    return all_hooks


def get_mcp_servers_from_file(mcp_path: Path, scope: str) -> list[dict]:
    """Get MCP servers from a specific file."""
    servers = []
    data = load_json(mcp_path)
    if data and "mcpServers" in data:
        for name, config in data["mcpServers"].items():
            servers.append(
                {
                    "id": f"{mcp_path}:{name}",
                    "type": "mcp_server",
                    "name": name,
                    "scope": scope,
                    "source_file": str(mcp_path),
                    "modified_at": get_file_mtime(mcp_path),
                    "command": config.get("command", ""),
                    "args": config.get("args", []),
                    "env": config.get("env", {}),
                }
            )
    return servers


def get_mcp_servers_from_folder(folder: Path, scope: str) -> list[dict]:
    """Get MCP servers from mcp.json or .mcp.json in a folder."""
    servers = []
    for filename in ["mcp.json", ".mcp.json"]:
        mcp_path = folder / filename
        if mcp_path.exists():
            servers.extend(get_mcp_servers_from_file(mcp_path, scope))
    return servers


def get_mcp_servers() -> list[dict]:
    """Get all MCP server configurations from user and all projects."""
    servers: list[dict] = []
    seen_names = set()

    if _RESOURCE_MGMT_AVAILABLE:
        for server in _fs_entities_to_items(McpServerResource.get_all()):
            servers.append(server)
            if server.get("name"):
                seen_names.add(server["name"])

    for server in get_mcp_servers_from_file(HOME / ".mcp.json", "user"):
        servers.append(server)
        seen_names.add(server["name"])

    for server in get_mcp_servers_from_folder(CLAUDE_HOME, "user"):
        if server["name"] not in seen_names:
            servers.append(server)
            seen_names.add(server["name"])

    legacy_settings = get_legacy_settings()
    if legacy_settings and "mcpServers" in legacy_settings:
        for name, config in legacy_settings.get("mcpServers", {}).items():
            if name in seen_names:
                continue
            seen_names.add(name)
            servers.append(
                {
                    "id": f"{HOME / '.claude.json'}:{name}",
                    "type": "mcp_server",
                    "name": name,
                    "scope": "user",
                    "source_file": str(HOME / ".claude.json"),
                    "modified_at": get_file_mtime(HOME / ".claude.json"),
                    "command": config.get("command", ""),
                    "args": config.get("args", []),
                    "env": config.get("env", {}),
                }
            )

    projects_dir = CLAUDE_HOME / "projects"
    if projects_dir.exists():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cwd = get_project_cwd(project_dir)
            if not cwd:
                continue
            project_path = Path(cwd)
            if not project_path.exists():
                continue

            for server in get_mcp_servers_from_file(project_path / ".mcp.json", "project"):
                if server["name"] not in seen_names:
                    servers.append(server)
                    seen_names.add(server["name"])

            for server in get_mcp_servers_from_folder(project_path / ".claude", "project"):
                if server["name"] not in seen_names:
                    servers.append(server)
                    seen_names.add(server["name"])

    return servers


def get_commands_from_folder(folder: Path, scope: str) -> list[dict]:
    """Get commands from a specific folder."""
    commands = []
    commands_dir = folder / "commands"
    if commands_dir.exists():
        for f in commands_dir.glob("*.md"):
            commands.append(
                {
                    "id": f"{scope}:{f.stem}:{folder}",
                    "type": "command",
                    "name": f.stem,
                    "scope": scope,
                    "source_file": str(f),
                    "path": str(f),
                    "modified_at": get_file_mtime(f),
                }
            )
    return commands


def get_commands() -> list[dict]:
    """Get all custom commands (global and from all projects)."""
    commands: list[dict] = []
    seen = set()

    if _RESOURCE_MGMT_AVAILABLE:
        for cmd in _fs_entities_to_items(CommandResource.get_all()):
            commands.append(cmd)
            if cmd.get("name"):
                seen.add(cmd["name"])

    for cmd in get_commands_from_folder(CLAUDE_HOME, "global"):
        commands.append(cmd)
        seen.add(cmd["name"])

    projects_dir = CLAUDE_HOME / "projects"
    if projects_dir.exists():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cwd = get_project_cwd(project_dir)
            if not cwd:
                continue
            project_path = Path(cwd)
            if not project_path.exists():
                continue

            for cmd in get_commands_from_folder(project_path / ".claude", "project"):
                if cmd["name"] not in seen:
                    commands.append(cmd)
                    seen.add(cmd["name"])

    return commands


def get_agents_from_folder(folder: Path, scope: str) -> list[dict]:
    """Get agents from a specific folder."""
    agents = []
    agents_dir = folder / "agents"
    if agents_dir.exists():
        for f in agents_dir.glob("*.md"):
            agents.append(
                {
                    "id": f"{scope}:{f.stem}:{folder}",
                    "type": "agent",
                    "name": f.stem,
                    "scope": scope,
                    "source_file": str(f),
                    "path": str(f),
                    "modified_at": get_file_mtime(f),
                }
            )
    return agents


def get_agents() -> list[dict]:
    """Get all custom agents (global, system, and from all projects)."""
    agents: list[dict] = []
    seen = set()

    if _RESOURCE_MGMT_AVAILABLE:
        for agent in _fs_entities_to_items(AgentResource.get_all()):
            agents.append(agent)
            if agent.get("name"):
                seen.add(agent["name"])

    for agent in get_agents_from_folder(CLAUDE_HOME, "global"):
        agents.append(agent)
        seen.add(agent["name"])

    for agent in get_system_agents():
        if agent["name"] not in seen:
            agents.append(agent)
            seen.add(agent["name"])

    projects_dir = CLAUDE_HOME / "projects"
    if projects_dir.exists():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cwd = get_project_cwd(project_dir)
            if not cwd:
                continue
            project_path = Path(cwd)
            if not project_path.exists():
                continue

            for agent in get_agents_from_folder(project_path / ".claude", "project"):
                if agent["name"] not in seen:
                    agents.append(agent)
                    seen.add(agent["name"])

    return agents


def get_skills_from_folder(folder: Path, scope: str) -> list[dict]:
    """Get skills from a specific folder."""
    skills = []
    skills_dir = folder / "skills"
    if skills_dir.exists():
        for item in skills_dir.iterdir():
            if not item.is_dir() or item.name.startswith("."):
                continue
            skills.append(
                {
                    "id": f"skill:{item.name}:{folder}",
                    "type": "skill",
                    "name": item.name,
                    "scope": scope,
                    "source_file": str(item),
                    "path": str(item),
                    "modified_at": get_file_mtime(item),
                    "usage_count": 0,
                }
            )
    return skills


def get_system_skills() -> list[dict]:
    """Get system skills from ~/Flowpad workspace/.flow/system_assets/skills."""
    skills: list[dict] = []
    # Primary: new system_assets layout
    system_skills_dir = HOME / "Flowpad workspace" / ".flow" / "system_assets" / "skills"
    # Fallback: legacy path
    if not system_skills_dir.exists():
        system_skills_dir = HOME / "Flowpad workspace" / ".flow" / "system_skills"
    if not system_skills_dir.exists():
        return skills

    for item in system_skills_dir.iterdir():
        if not item.is_dir() or item.name.startswith("."):
            continue
        skills.append(
            {
                "id": f"skill:{item.name}:{system_skills_dir}",
                "type": "skill",
                "name": item.name,
                "scope": "system",
                "source_file": str(item),
                "path": str(item),
                "modified_at": get_file_mtime(item),
                "usage_count": 0,
            }
        )
    return skills


def get_system_agents() -> list[dict]:
    """Get system agents from ~/Flowpad workspace/.flow/system_assets/agents."""
    agents: list[dict] = []
    system_agents_dir = HOME / "Flowpad workspace" / ".flow" / "system_assets" / "agents"
    if not system_agents_dir.exists():
        return agents

    for item in system_agents_dir.iterdir():
        if not item.is_dir() or item.name.startswith("."):
            continue
        agents.append(
            {
                "id": f"agent:{item.name}:{system_agents_dir}",
                "type": "agent",
                "name": item.name,
                "scope": "system",
                "source_file": str(item),
                "path": str(item),
                "modified_at": get_file_mtime(item),
            }
        )
    return agents


def get_skills() -> list[dict]:
    """Get installed skills (global, system, and from all projects)."""
    skills: list[dict] = []
    seen = set()

    if _RESOURCE_MGMT_AVAILABLE:
        for skill in _fs_entities_to_items(SkillResource.get_all()):
            skills.append(skill)
            if skill.get("name"):
                seen.add(skill["name"])

    for skill in get_skills_from_folder(CLAUDE_HOME, "user"):
        skills.append(skill)
        seen.add(skill["name"])

    for skill in get_system_skills():
        if skill["name"] not in seen:
            skills.append(skill)
            seen.add(skill["name"])

    projects_dir = CLAUDE_HOME / "projects"
    if projects_dir.exists():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            cwd = get_project_cwd(project_dir)
            if not cwd:
                continue
            project_path = Path(cwd)
            if not project_path.exists():
                continue

            for skill in get_skills_from_folder(project_path / ".claude", "project"):
                if skill["name"] not in seen:
                    skills.append(skill)
                    seen.add(skill["name"])

    legacy = get_legacy_settings()
    if legacy and "skillUsage" in legacy:
        usage_map = {name: stats.get("usageCount", 0) for name, stats in legacy["skillUsage"].items()}
        for skill in skills:
            skill["usage_count"] = usage_map.get(skill["name"], 0)

    return skills
