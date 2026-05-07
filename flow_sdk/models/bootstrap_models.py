"""Bootstrap response models for the minihub server.

Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (AppPaths, LmInfo)
and flowpad/hub/app/actions/bootstrap_actions.py (BootstrapInfo).
"""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class AppPaths(BaseModel):
    """Application paths - VFS-relative paths ready to use with fsManager.

    All paths are relative to the storage mount (OS root), without leading slash.
    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """

    root: str  # Filesystem root ("/" on Unix, "C:\\" on Windows)
    home: str  # User home directory ("Users/shlom")
    workspace: str  # FlowPad workspace folder ("Users/shlom/Flowpad workspace")
    skills: str  # Skills folder ("Users/shlom/Flowpad workspace/.claude/skills")
    user_skills: str  # Personal skills folder ("Users/shlom/.claude/skills")
    system_skills: str  # System skills folder ("Users/shlom/Flowpad workspace/.flow/system_assets/skills")
    system_agents: str  # System agents folder ("Users/shlom/Flowpad workspace/.flow/system_assets/agents")
    user_agents: str = ""  # Personal agents folder ("Users/shlom/.claude/agents")
    logs: str  # Logs folder ("Users/shlom/Flowpad workspace/.flow/logs")
    settings: str  # Settings file ("Users/shlom/Flowpad workspace/.flow/settings.json")


class EnvInfo(BaseModel):
    """Environment information."""
    env_name: str
    cloud_api_url: Optional[str] = None
    version: Optional[str] = None


class LmInfo(BaseModel):
    """Information about available LLM API providers and installed agents in desktop environment.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """

    llm_providers: List[str] = []
    installed_agents: List[str] = []  # List of agent names (e.g., "Claude Code", "Cursor")
    cloud_login_available: bool = False  # Whether cloud login is available
    cloud_url: Optional[str] = None  # FLOWPAD_HUB_URL — shown in login button tooltip
    # Application paths - all VFS-relative, ready to use
    paths: Optional[AppPaths] = None
    # Legacy desktop paths (deprecated - use paths instead)
    home: Optional[str] = None  # VFS home path (e.g., "Users/shlom")
    workspace: Optional[str] = None  # Workspace folder name (e.g., "Flowpad workspace")
    skills: Optional[str] = None  # Skills folder relative to workspace
    logs: Optional[str] = None  # Logs folder relative to workspace


class BootstrapInfo(BaseModel):
    """Bootstrap information returned to the UI SDK on startup.

    Matches production FlowPad BootstrapInfo fields for API compatibility.
    Production source: flowpad/hub/app/actions/bootstrap_actions.py
    """
    schemas: List[Dict[str, Any]] = []
    user: Optional[Dict[str, Any]] = None
    domain: Optional[Dict[str, Any]] = None
    visitor: Optional[Dict[str, Any]] = None
    default_project: Optional[Dict[str, Any]] = None
    default_workspace: Optional[Dict[str, Any]] = None
    default_compute_node: Optional[Dict[str, Any]] = None
    sandbox_available: bool = False
    sandbox_compute_node: Optional[Dict[str, Any]] = None
    docker_available: bool = False
    docker_compute_nodes: List[Dict[str, Any]] = []
    env: Optional[EnvInfo] = None
    desktop_info: Optional[LmInfo] = None
    sniffer_hook: Optional[Dict[str, Any]] = None
    scan_info: Optional[Dict[str, Any]] = None
    records_data_dir: Optional[str] = None


__all__ = ["AppPaths", "EnvInfo", "LmInfo", "BootstrapInfo"]
