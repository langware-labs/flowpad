"""
Bootstrap route - initializes local entities and returns BootstrapInfo.

This endpoint is called by the UI SDK on startup to get initialization data.

Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
Key functions brought over:
  - get_email() -- multi-source email detection (git, OS, env)
  - init_desktop_user() logic -> get_or_create_local_user()
  - init_local_project() -> get_or_create_local_project() with owner
  - init_local_workspace() -> get_or_create_local_workspace() with owner
  - init_local_compute_node() -> get_or_create_local_compute_node() with os_root, StorageProvider
  - init_local_agent() -> get_or_create_local_agent() with agent config
  - Standalone getters: get_desktop_user(), get_local_entity(), etc.
  - Agent detection: OS-specific Claude Code / Cursor detection
  - VFS paths: build_app_paths() with proper VFS-relative computation
  - File system setup: .flow/logs, .flow/system_skills, settings.json
  - Cloud token stubs (flow-cli has no cloud auth)
  - detect_available_llm_providers() using LLMProvider enum
  - get_desktop_info() assembling full LmInfo
"""

import asyncio
import json
import logging
import os
import platform
import shutil
import socket
import subprocess
import time
import uuid
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.builtin.workspace import Workspace
from flow_sdk.config import (
    AGENT_MOUNT_FOLDER,
    FLOWPAD_ASSISTANT_DIRNAME,
    FLOWPAD_ASSISTANT_PROJECT_NAME,
    FLOWPAD_ASSISTANT_PROJECT_UNAME,
    ComputeProviderType,
    StorageProvider,
    flowpad_assistant_project_root,
    get_os_root_path,
    system_projects_root,
)
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.core.schema import get_public_schema
from flow_sdk.db.database import init_db
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMProvider
from flow_sdk.flowpad_types.runtime_environment import OSType, RuntimeEnvironment
from flow_sdk._version import __version__
from flow_sdk.models import AppPaths, BootstrapInfo, EnvInfo, LmInfo
from flow_sdk.models.responses import ApiSuccessResponse

router = APIRouter()


# ---------------------------------------------------------------------------
# Constants (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------

DESKTOP_LABEL = "--user-type--.desktop"

# Marks a user whose `name` was set manually via the UI — bootstrap will not
# overwrite it from `git config user.name` on subsequent server starts.
NAME_OVERRIDE_LABEL = "--user--.name-overridden"

# Domain for default desktop user email
DESKTOP_EMAIL_DOMAIN = "desktop.local"

# Cloud token SOD name (stub -- flow-cli does not use SOD cloud tokens)
CLOUD_TOKEN_SOD_NAME = "flowpad_token"


class AgentName(StrEnum):
    """Enum for LLM agent application names.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """

    CLAUDE_CODE = "Claude Code"
    CURSOR = "Cursor"


# Agents to check for installation
AGENTS_TO_CHECK = [AgentName.CLAUDE_CODE, AgentName.CURSOR]


# ---------------------------------------------------------------------------
# Email detection (migrated from desktop_loader.py:get_email)
# ---------------------------------------------------------------------------


def get_default_desktop_email() -> str:
    """Generate a default email for desktop users when no email is found.

    Returns:
        Default email in format 'hostname@desktop.local'

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    hostname = socket.gethostname()
    return f"{hostname}@{DESKTOP_EMAIL_DOMAIN}"


def get_name() -> Optional[str]:
    """Get user full name from git config user.name."""
    try:
        result = subprocess.run(
            ["git", "config", "user.name"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        name = result.stdout.strip()
        if name:
            return name
    except Exception:
        pass
    return None


def get_email() -> Optional[str]:
    """Get user email from git config or OS-specific sources.

    Tries multiple sources in order:
    1. git config user.email
    2. OS-specific methods (macOS defaults, Windows registry)
    3. Environment variables (EMAIL, USER_EMAIL)

    Returns:
        User email address or None if not found

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    # Try git config first
    try:
        result = subprocess.run(
            ["git", "config", "user.email"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        email = result.stdout.strip()
        if email:
            return email
    except Exception:
        pass

    # Try OS-specific methods
    system = platform.system()

    if system == "Darwin":  # macOS
        try:
            result = subprocess.run(
                ["defaults", "read", "MobileMeAccounts", "Accounts"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if result.returncode == 0:
                # Parse AccountID from output
                for line in result.stdout.split("\n"):
                    if "AccountID" in line and "@" in line:
                        # Extract email from line like: AccountID = "email@example.com";
                        parts = line.split('"')
                        if len(parts) >= 2:
                            email = parts[1].strip()
                            if "@" in email:
                                return email
        except Exception:
            pass

    elif system == "Windows":
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\IdentityCRL\UserExtendedProperties",
            )
            # Enumerate subkeys to find email
            email = winreg.EnumKey(key, 0)
            if email and "@" in email:
                return email
        except Exception:
            pass

    # Fall back to environment variables
    email = os.environ.get("EMAIL") or os.environ.get("USER_EMAIL")
    if email:
        return email

    return None


# ---------------------------------------------------------------------------
# Agent detection helpers (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------


def _get_current_os_type() -> OSType:
    """Get current operating system type as OSType enum.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    system = platform.system()
    if system == "Windows":
        return OSType.WINDOWS
    elif system == "Darwin":
        return OSType.MACOS
    elif system == "Linux":
        return OSType.LINUX
    else:
        # Default to Linux for unknown systems
        return OSType.LINUX


def _check_claude_code_installed(os_type: OSType) -> bool:
    """Check if Claude Code is installed on the system.

    Args:
        os_type: Current operating system type

    Returns:
        True if Claude Code is installed, False otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    # Check PATH first
    claude_path = shutil.which("claude")
    if claude_path:
        return True

    # Check platform-specific paths
    if os_type == OSType.WINDOWS:
        appdata = os.environ.get("APPDATA", "")
        program_files = os.environ.get("ProgramFiles", "")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", "")

        windows_paths = [
            os.path.join(appdata, "npm", "claude.cmd"),
            os.path.join(appdata, "npm", "claude"),
            os.path.join(program_files, "nodejs", "claude.cmd"),
            os.path.join(program_files_x86, "nodejs", "claude.cmd"),
        ]
        for path in windows_paths:
            if os.path.exists(path):
                return True

    elif os_type in (OSType.MACOS, OSType.LINUX):
        home = str(Path.home())
        unix_paths = [
            os.path.join(home, ".npm-global", "bin", "claude"),
            "/usr/local/bin/claude",
            os.path.join(home, ".local", "bin", "claude"),
            os.path.join(home, "node_modules", ".bin", "claude"),
            os.path.join(home, ".yarn", "bin", "claude"),
            os.path.join(home, ".claude", "local", "claude"),
        ]
        for path in unix_paths:
            if os.path.exists(path):
                return True

    return False


def _check_cursor_installed(os_type: OSType) -> bool:
    """Check if Cursor is installed on the system.

    Args:
        os_type: Current operating system type

    Returns:
        True if Cursor is installed, False otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    # Check PATH first
    cursor_path = shutil.which("cursor")
    if cursor_path:
        return True

    # Check platform-specific paths
    if os_type == OSType.WINDOWS:
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("ProgramFiles", "")

        windows_paths = [
            os.path.join(local_appdata, "Programs", "Cursor", "Cursor.exe"),
            os.path.join(program_files, "Cursor", "Cursor.exe"),
        ]
        for path in windows_paths:
            if os.path.exists(path):
                return True
    elif os_type == OSType.MACOS:
        cursor_app_path = os.path.join(os.path.expanduser("~"), "Applications", "Cursor.app")
        if os.path.exists(cursor_app_path):
            return True
    elif os_type == OSType.LINUX:
        linux_paths = [
            os.path.join(os.path.expanduser("~"), ".local", "bin", "cursor"),
            "/usr/local/bin/cursor",
            "/usr/bin/cursor",
        ]
        for path in linux_paths:
            if os.path.exists(path):
                return True

    return False


def _check_agent_installed(agent_name: AgentName, os_type: OSType) -> bool:
    """Generic function to check if an agent is installed.

    Args:
        agent_name: Name of the agent to check
        os_type: Current operating system type

    Returns:
        True if the agent is installed, False otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    if agent_name == AgentName.CLAUDE_CODE:
        return _check_claude_code_installed(os_type)
    elif agent_name == AgentName.CURSOR:
        return _check_cursor_installed(os_type)
    else:
        return False


def get_installed_agents() -> List[str]:
    """Get list of installed LLM agent applications on the machine.

    Detects installed applications like Claude Code, Cursor, etc. by checking
    for executables in PATH and common installation directories.

    Returns:
        List of agent names (e.g., ["Claude Code", "Cursor"])

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    installed_agents = []
    os_type = _get_current_os_type()

    # Iterate over agents and check if they're installed
    for agent_name in AGENTS_TO_CHECK:
        if _check_agent_installed(agent_name, os_type):
            installed_agents.append(agent_name.value)

    return installed_agents


# ---------------------------------------------------------------------------
# LLM provider detection (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------


def detect_available_llm_providers() -> List[LLMProvider]:
    """Detect available LLM providers by scanning environment variables for API keys.

    Returns:
        List of LLMProvider enum values for providers with available API keys

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    providers = []

    # Check Anthropic
    if os.getenv("ANTHROPIC_API_KEY"):
        providers.append(LLMProvider.Anthropic)

    # Check OpenAI
    if os.getenv("OPENAI_API_KEY"):
        providers.append(LLMProvider.OpenAI)

    # Check Groq
    if os.getenv("GROQ_API_KEY"):
        providers.append(LLMProvider.Groq)

    # Check Perplexity
    if os.getenv("PERPLEXITY_API_KEY"):
        providers.append(LLMProvider.Perplexity)

    # Check VertexAI (requires Google Cloud credentials)
    if os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or os.getenv("GOOGLE_CLOUD_PROJECT_ID"):
        providers.append(LLMProvider.VertexAI)

    return providers


# ---------------------------------------------------------------------------
# VFS path utilities (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------


def get_vfs_home_path() -> str:
    """Get the VFS home path (Linux-style, relative to root).

    Returns:
        VFS path like "Users/username"

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    home_path = os.path.expanduser("~")
    username = os.path.basename(home_path)
    return f"Users/{username}"


def build_app_paths() -> AppPaths:
    """Build all application paths using simple concatenation.

    All paths are VFS-relative (without leading slash) since the storage
    is mounted at the OS root (/ on Unix, C:\\ on Windows).

    Returns:
        AppPaths object with all paths fully resolved and ready to use with fsManager.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    root = get_os_root_path()
    # Get home path relative to root (strip leading slash for VFS)
    home_abs = str(get_instance_settings().user_home)
    if platform.system() == "Windows":
        # On Windows: strip drive letter (e.g., "C:\") and normalize backslashes to forward slashes
        # "C:\Users\tamir" -> "Users/tamir"
        home = home_abs.replace("\\", "/")
        if len(home) >= 2 and home[1] == ":":
            home = home[2:].lstrip("/")
    else:
        # On Unix: just strip leading slash
        # "/Users/tamir" -> "Users/tamir"
        home = home_abs.lstrip("/")
    workspace = f"{home}/Flowpad workspace"
    skills = f"{workspace}/.claude/skills"
    user_skills = f"{home}/.claude/skills"
    user_agents = f"{home}/.claude/agents"
    _assistant_root = flowpad_assistant_project_root()
    system_skills = str(_assistant_root / ".claude" / "skills")
    system_agents = str(_assistant_root / ".claude" / "agents")
    logs = f"{home}/.flow/logs"
    settings = f"{workspace}/.flow/settings.json"

    return AppPaths(
        root=root,
        home=home,
        workspace=workspace,
        skills=skills,
        user_skills=user_skills,
        user_agents=user_agents,
        system_skills=system_skills,
        system_agents=system_agents,
        logs=logs,
        settings=settings,
    )


# ---------------------------------------------------------------------------
# Cloud token management stubs (flow-cli has no cloud auth)
# ---------------------------------------------------------------------------


async def get_cloud_token() -> Optional[str]:
    """Get the cloud token from SOD storage.

    Stub: flow-cli does not use cloud tokens. Always returns None.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (stubbed)
    """
    return None


async def store_cloud_token(token: str) -> bool:
    """Store the cloud token in SOD storage.

    Stub: flow-cli does not use cloud tokens. Always returns False.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (stubbed)
    """
    return False


async def delete_cloud_token() -> bool:
    """Delete the cloud token from SOD storage.

    Stub: flow-cli does not use cloud tokens. Always returns False.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (stubbed)
    """
    return False


async def validate_cloud_token(token: Optional[str] = None) -> bool:
    """Validate the cloud token by checking if it's a valid JWT.

    Stub: flow-cli does not use cloud tokens. Always returns False.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (stubbed)
    """
    return False


async def is_cloud_login_available() -> bool:
    """Check if cloud login is available.

    Validates the stored API key against the Flowpad cloud (real HTTP call).
    To avoid triggering a macOS keychain prompt at startup for unrecognized
    binaries, we gate the keychain read on the non-prompting sentinel probe
    (``is_secrets_enabled``). If the user has not yet approved keychain
    access, we treat them as logged-out and the UI's SecretApprovalDialog
    will prompt before any subsequent login attempt.

    Returns False on any failure (no sentinel, no key, network error, invalid
    token). Logout cleanup is the caller's responsibility — bootstrap only
    reports the current validity.
    """
    api_key = None
    try:
        from flow_sdk.cli.auth.hub_login import validate_api_key_async, get_api_key
        from flow_sdk.cli.auth.secrets import is_secrets_enabled

        # Non-prompting probe: skip keychain read entirely if user hasn't approved.
        if not await asyncio.to_thread(is_secrets_enabled):
            return False

        api_key = await asyncio.to_thread(get_api_key)
        if not api_key:
            return False

        # Real cloud validation — succeeds only when the token is still valid.
        await validate_api_key_async(api_key)
        return True
    except Exception:
        # Stored token failed validation (expired, revoked, network error). When
        # we definitely had a key, drop it from the keychain and clear the user
        # record so the UI reflects logged-out state without further round-trips.
        if api_key:
            try:
                from flow_sdk.cli.app_config import set_user
                from flow_sdk.cli.auth.hub_login import delete_api_key
                await asyncio.to_thread(delete_api_key)
                set_user({})
            except Exception:
                pass
        return False


# ---------------------------------------------------------------------------
# Desktop entity getters (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------


async def get_desktop_user() -> Optional[Entity]:
    """Get the desktop user by querying for users with desktop label.

    Queries all users and filters by --user-type--.desktop label.

    Returns:
        Desktop User entity if found, None otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    try:
        all_users = await User.get_all(entities_filter=None)
        desktop_users = [user for user in all_users if DESKTOP_LABEL in (user.labels or [])]

        if len(desktop_users) == 0:
            return None

        if len(desktop_users) > 1:
            logging.warning(f"Expected 1 desktop user, found {len(desktop_users)} - using first one")

        return desktop_users[0]

    except Exception as e:
        logging.error(f"Failed to get desktop user: {e}")
        return None


async def get_local_entity(entity_class) -> Optional[Entity]:
    """Get a local entity by querying for entity with uname='local'.

    Args:
        entity_class: The entity class to query (must have get_by_uname method)

    Returns:
        Entity with uname='local' if found, None otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    entity_name = entity_class.__name__ if hasattr(entity_class, "__name__") else str(entity_class)
    try:
        local_entity = await entity_class.get_by_uname("local")
        return local_entity
    except Exception as e:
        if "Multiple rows were found" in str(e):
            try:
                local_entities = await entity_class.get_all({"match": {"uname": "local"}})
                if local_entities:
                    logging.warning(
                        f"Found {len(local_entities)} @local {entity_name} rows, using the first one: {local_entities[0].id}"
                    )
                    return local_entities[0]
            except Exception as list_error:
                logging.error(f"Failed to resolve duplicate @local {entity_name} rows: {list_error}")
        logging.error(f"Failed to get local {entity_name}: {e}")
        return None


async def get_desktop_compute_node() -> Optional[Entity]:
    """Get the desktop compute node by querying for compute node with uname='local'.

    Returns:
        Desktop ComputeNode entity if found, None otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    return await get_local_entity(ComputeNode)


async def get_desktop_project() -> Optional[Entity]:
    """Get the @local project by querying for project with uname='local'.

    Returns:
        @local Project entity if found, None otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    return await get_local_entity(Project)


async def get_desktop_workspace() -> Optional[Entity]:
    """Get the @local workspace by querying for workspace with uname='local'.

    Returns:
        @local Workspace entity if found, None otherwise

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    return await get_local_entity(Workspace)


# ---------------------------------------------------------------------------
# Entity initialization (migrated from desktop_loader.py)
# ---------------------------------------------------------------------------


async def get_or_create_local_user() -> User:
    """Get or create the @local desktop user.

    Uses get_email() to try multiple sources for the user's email:
    1. git config user.email
    2. OS-specific methods (macOS MobileMeAccounts, Windows registry)
    3. Environment variables (EMAIL, USER_EMAIL)
    4. Falls back to hostname@desktop.local

    Derives user display name from email: email.split("@")[0].replace(".", " ").title()

    Handles email conflict with delete-and-retry logic from FlowPad.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_desktop_user)
    """
    # Check if desktop user already exists (by label)
    desktop_user = await get_desktop_user()
    if desktop_user:
        # Handle existing desktop user with no email - update with default email
        if not desktop_user.email:
            default_email = get_default_desktop_email()
            logging.info(f"Desktop user {desktop_user.id} has no email, setting default: {default_email}")
            desktop_user.email = default_email
            await desktop_user.save()
        # Refresh name from git config user.name unless the user manually overrode it
        manually_overridden = NAME_OVERRIDE_LABEL in (desktop_user.labels or [])
        git_name = await asyncio.to_thread(get_name)
        if not manually_overridden and git_name and desktop_user.name != git_name:
            old_name = desktop_user.name
            desktop_user.name = git_name
            await desktop_user.save()
            logging.info(f"Updated desktop user {desktop_user.id} name: {old_name} -> {git_name}")
        logging.info(f"Desktop user already exists: {desktop_user.id} ({desktop_user.email}, {desktop_user.name})")
        return desktop_user

    # Also check by uname for backward compatibility with pre-migration entities
    existing_by_uname = await get_local_entity(User)
    if existing_by_uname:
        # Ensure it has the desktop label
        if DESKTOP_LABEL not in (existing_by_uname.labels or []):
            existing_by_uname.add_label(DESKTOP_LABEL)
            await existing_by_uname.save()
        # Update email/name: prefer git config user.name unless manually overridden
        email = await asyncio.to_thread(get_email) or get_default_desktop_email()
        git_name = await asyncio.to_thread(get_name)
        name_from_email = email.split("@")[0].replace(".", " ").title()
        manually_overridden = NAME_OVERRIDE_LABEL in (existing_by_uname.labels or [])
        needs_email_update = not existing_by_uname.email
        needs_name_update = not manually_overridden and (
            existing_by_uname.name == "Local Desktop User"
            or (git_name and existing_by_uname.name != git_name)
        )
        if needs_email_update or needs_name_update:
            if needs_email_update:
                existing_by_uname.email = email
            if needs_name_update:
                existing_by_uname.name = git_name or name_from_email
            await existing_by_uname.save()
            logging.info(f"Updated @local user with email: {existing_by_uname.email}, name: {existing_by_uname.name}")
        return existing_by_uname

    # Create new desktop user
    email = await asyncio.to_thread(get_email)
    if not email:
        email = get_default_desktop_email()
        logging.info(f"No email found for desktop user, using default: {email}")

    # Prefer git config user.name; fall back to email-derived name
    git_name = await asyncio.to_thread(get_name)
    name = git_name or email.split("@")[0].replace(".", " ").title()

    user = User(
        type="user",
        uname="local",
        name=name,
        email=email,
        visitor_role="owner",
    )
    user.add_label(DESKTOP_LABEL)

    # Try to save - if it fails due to existing email, delete the old user and retry
    try:
        await user.save()
    except Exception as save_error:
        if "already exist" in str(save_error) and email in str(save_error):
            logging.info(f"Deleting pre-existing user with email {email} and recreating with desktop label")
            existing_user = await User.get_user_by_email(email)
            if existing_user:
                await existing_user.delete()
                await user.save()
            else:
                raise save_error
        else:
            raise save_error

    logging.info(f"Created desktop user: {user.id} ({email})")
    return user


async def get_or_create_local_project(desktop_user: Optional[Entity] = None) -> Project:
    """Get or create the @local project.

    Creates a Project entity with uname="local" if it doesn't exist.
    Sets visitor_role to "owner" for unrestricted access and assigns desktop user as owner.

    Args:
        desktop_user: The desktop User entity to set as owner

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_local_project)
    """
    project = await get_local_entity(Project)
    if project:
        logging.info(f"@local project already exists: {project.id}")
        return project

    logging.info("Creating @local project for desktop environment")
    project = Project(
        type="project",
        uname="local",
        name="my_first_project",
        visitor_role="owner",
    )
    try:
        await project.save(owner=desktop_user)
    except Exception as save_error:
        if "already exist" in str(save_error):
            logging.info("@local project already exists (race/cache miss), fetching it")
            # Bypass uname_cache in case it has a stale entry
            existing = await Project.get_by_prop("uname", "local", "project")
            if existing:
                return existing
        raise save_error
    await project.set_visitor_role("owner")
    logging.info(f"Created @local project: {project.id} with owner: {desktop_user.id if desktop_user else 'None'}")
    return project


async def get_or_create_local_workspace(desktop_user: Optional[Entity] = None) -> Workspace:
    """Get or create the @local workspace.

    Creates a Workspace entity with uname="local" if it doesn't exist.
    Sets visitor_role to "owner" for unrestricted access and assigns desktop user as owner.

    Args:
        desktop_user: The desktop User entity to set as owner

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_local_workspace)
    """
    workspace = await get_local_entity(Workspace)
    if workspace:
        logging.info(f"@local workspace already exists: {workspace.id}")
        return workspace

    logging.info("Creating @local workspace for desktop environment")
    workspace = Workspace(
        type="workspace",
        uname="local",
        name="Local Desktop Workspace",
        visitor_role="owner",
    )
    try:
        await workspace.save(owner=desktop_user)
    except Exception as save_error:
        if "already exist" in str(save_error):
            logging.info("@local workspace already exists (race/cache miss), fetching it")
            # Bypass uname_cache in case it has a stale entry
            existing = await Workspace.get_by_prop("uname", "local", "workspace")
            if existing:
                return existing
        raise save_error
    await workspace.set_visitor_role("owner")
    logging.info(f"Created @local workspace: {workspace.id} with owner: {desktop_user.id if desktop_user else 'None'}")
    return workspace


async def get_or_create_local_compute_node(
    local_project: Optional[Entity] = None,
    desktop_user: Optional[Entity] = None,
) -> ComputeNode:
    """Get or create the @local compute node with filesystem storage mounted at root.

    Uses SANDBOX storage provider with fs_storage_mount_path set to the OS root
    (/ on Unix, C:\\ on Windows) to browse the entire local filesystem.

    Args:
        local_project: The Project entity to link the compute node to
        desktop_user: The desktop User entity to set as owner

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_local_compute_node)
    """
    os_root = get_os_root_path()

    compute_node = await get_local_entity(ComputeNode)
    already_existed = compute_node is not None
    if compute_node:
        logging.info(f"@local compute node already exists: {compute_node.id}")
        # Ensure storage settings are correct for existing @local compute node
        needs_update = False
        if compute_node.fs_storage_provider != StorageProvider.SANDBOX:
            compute_node.fs_storage_provider = StorageProvider.SANDBOX
            needs_update = True
        if compute_node.fs_storage_mount_path != os_root:
            compute_node.fs_storage_mount_path = os_root
            needs_update = True
        if needs_update:
            await compute_node.save()
            logging.info(f"Updated @local compute node storage settings: provider=SANDBOX, mount_path={os_root}")
    else:
        logging.info("Creating @local compute node for desktop environment")
        compute_node = ComputeNode(
            type="compute_node",
            uname="local",
            name="@local",
            runtime=RuntimeEnvironment(name="local_desktop_runtime"),
            node_provider_type=ComputeProviderType.LOCAL_MACHINE,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path=os_root,
            visitor_role="owner",
        )
        try:
            await compute_node.save(owner=desktop_user)
        except Exception as save_error:
            if "already exist" in str(save_error):
                logging.info("@local compute node already exists (race/cache miss), fetching it")
                # Bypass uname_cache in case it has a stale entry
                existing = await ComputeNode.get_by_prop("uname", "local", "compute_node")
                if existing:
                    compute_node = existing
                    already_existed = True
                else:
                    raise save_error
            else:
                raise save_error
        logging.info(
            f"Created @local compute node: {compute_node.id} with owner: "
            f"{desktop_user.id if desktop_user else 'None'}, mount_path: {os_root}"
        )

    # Only link to project and set visitor role on first creation (expensive DB ops)
    if not already_existed:
        if local_project:
            await local_project.add_child(compute_node)
        await compute_node.set_visitor_role("owner")

    # Generate provider_id if not set (needed for PTY operations)
    if not compute_node.node_provider_id:
        try:
            compute_node.node_provider_id = _new_provider_id("name")
            await compute_node.save()
            logging.info(f"@local compute node initialized with provider_id: {compute_node.node_provider_id}")
        except Exception as e:
            logging.warning(f"Failed to initialize @local compute node provider_id: {e}")

    return compute_node


def _new_provider_id(prefix: str) -> str:
    """Stable per-process id used by PTY session manager & provider caches."""
    return f"{prefix}_{uuid.uuid4()}"


def is_sandbox_available() -> bool:
    """True iff the E2B SDK is installed and an E2B_KEY is configured.

    Drives both the bootstrap `sandbox_available` flag and whether the
    @sandbox compute node is created.
    """
    if not os.getenv("E2B_KEY"):
        return False
    try:
        from flow_sdk.compute.providers.e2b.provider import E2B_AVAILABLE  # noqa: PLC0415
        return E2B_AVAILABLE
    except Exception:
        return False


async def get_docker_compute_nodes() -> list:
    """Return @docker-* ComputeNode entities for every live worker in the registry.

    Only returns nodes that both (a) exist in the DB and (b) have an active
    WS connection — i.e. the container is currently reachable.
    """
    try:
        from flow_sdk.compute.providers.docker import docker_registry  # noqa: PLC0415
    except Exception:
        return []

    live_machine_ids = [w["machine_id"] for w in docker_registry.list_workers()]
    if not live_machine_ids:
        return []

    # Resolve by provider id directly — avoids fetching every @docker-* CN.
    results = []
    for mid in live_machine_ids:
        try:
            cn = await ComputeNode.get_by_prop("node_provider_id", mid, "compute_node")
        except Exception:
            continue
        if cn is not None:
            results.append(cn)
    return results


async def get_or_create_sandbox_compute_node(
    local_project: Optional[Entity] = None,
    desktop_user: Optional[Entity] = None,
) -> ComputeNode:
    """Get or create the @sandbox compute node backed by E2B.

    Mirrors get_or_create_local_compute_node but uses ComputeProviderType.E2B
    and a sandbox-scoped mount path (/home/user). The actual E2B Sandbox
    boots lazily on first PTY attach.
    """
    sandbox_mount_path = "/home/user"

    compute_node: Optional[ComputeNode] = None
    try:
        compute_node = await ComputeNode.get_by_prop("uname", "sandbox", "compute_node")
    except Exception as e:
        if "Multiple rows were found" in str(e):
            try:
                rows = await ComputeNode.get_all({"match": {"uname": "sandbox"}})
                if rows:
                    compute_node = rows[0]
            except Exception as list_error:
                logging.error(f"Failed to resolve duplicate @sandbox rows: {list_error}")

    already_existed = compute_node is not None
    if compute_node is None:
        logging.info("Creating @sandbox compute node for E2B environment")
        compute_node = ComputeNode(
            type="compute_node",
            uname="sandbox",
            name="@sandbox",
            runtime=RuntimeEnvironment(name="e2b_sandbox_runtime", os_type=OSType.LINUX),
            node_provider_type=ComputeProviderType.E2B,
            fs_storage_provider=StorageProvider.SANDBOX,
            fs_storage_mount_path=sandbox_mount_path,
            visitor_role="owner",
        )
        try:
            await compute_node.save(owner=desktop_user)
        except Exception as save_error:
            if "already exist" in str(save_error):
                existing = await ComputeNode.get_by_prop("uname", "sandbox", "compute_node")
                if existing:
                    compute_node = existing
                    already_existed = True
                else:
                    raise save_error
            else:
                raise save_error
        logging.info(
            f"Created @sandbox compute node: {compute_node.id} with owner: "
            f"{desktop_user.id if desktop_user else 'None'}"
        )

    if not already_existed:
        if local_project:
            await local_project.add_child(compute_node)
        await compute_node.set_visitor_role("owner")

    if not compute_node.node_provider_id:
        try:
            compute_node.node_provider_id = _new_provider_id("sandbox")
            await compute_node.save()
            logging.info(
                f"@sandbox compute node initialized with provider_id: {compute_node.node_provider_id}"
            )
        except Exception as e:
            logging.warning(f"Failed to initialize @sandbox provider_id: {e}")

    return compute_node


# ---------------------------------------------------------------------------
# System projects — Project records mounted at SDK-shipped asset folders.
# ---------------------------------------------------------------------------


async def _ensure_system_projects(desktop_user: Optional[Entity] = None) -> list[Project]:
    """Upsert one Project per subdirectory of flow_sdk/system_projects/.

    Idempotent: queried by uname. Updates fs_storage_mount_path when the SDK
    install path moves (e.g. editable → wheel). Currently only the Flowpad
    Assistant is shipped, but the loop accommodates future system projects.
    """
    root = system_projects_root()
    if not root.is_dir():
        logging.info(f"[bootstrap] No system_projects/ at {root}, skipping")
        return []

    ensured: list[Project] = []
    for sub in sorted(root.iterdir()):
        if not sub.is_dir() or sub.name.startswith('.'):
            continue
        if sub.name == FLOWPAD_ASSISTANT_DIRNAME:
            uname = FLOWPAD_ASSISTANT_PROJECT_UNAME
            display_name = FLOWPAD_ASSISTANT_PROJECT_NAME
        else:
            uname = sub.name
            display_name = sub.name.replace('_', ' ').title()

        mount_path = str(sub)
        existing = await Project.get_by_prop("uname", uname, "project")
        if existing:
            dirty = False
            if existing.fs_storage_mount_path != mount_path:
                existing.fs_storage_mount_path = mount_path
                dirty = True
            if not getattr(existing, "system", False):
                existing.system = True
                dirty = True
            if dirty:
                await existing.save()
                logging.info(f"[bootstrap] Updated system project '{uname}' → mount={mount_path} system=True")
            ensured.append(existing)
            continue

        project = Project(
            type="project",
            uname=uname,
            name=display_name,
            fs_storage_mount_path=mount_path,
            fs_storage_provider=StorageProvider.LOCAL.value,
            visitor_role="owner",
            system=True,
        )
        try:
            await project.save(owner=desktop_user)
        except Exception as save_error:
            if "already exist" in str(save_error):
                retry = await Project.get_by_prop("uname", uname, "project")
                if retry:
                    ensured.append(retry)
                    continue
            raise
        await project.set_visitor_role("owner")
        ensured.append(project)
        logging.info(f"[bootstrap] Created system project '{uname}' at {mount_path}")

    return ensured


async def _ensure_welcome_favorite(user: User) -> None:
    """One-shot onboarding: drop a favorite bookmark to the Welcome markdown
    onto the user's home view the first time the server boots.

    Idempotent via ``user.onboarded``. If the Welcome markdown isn't indexed
    yet (indexer is async), retry a few times; if still not found, leave
    ``onboarded`` False so the next bootstrap retries.
    """
    if getattr(user, "onboarded", False):
        return

    from flow_sdk.builtin.bookmark import Bookmark, BookmarkType  # noqa: PLC0415
    from flow_sdk.builtin.claude_memory_entities import Docs  # noqa: PLC0415

    welcome = None
    for _ in range(5):
        candidates = await Docs.get_all({"name": "Welcome"})
        if candidates:
            welcome = candidates[0]
            break
        await asyncio.sleep(0.5)
    if welcome is None:
        logging.info("[bootstrap] Welcome markdown not yet indexed; skipping favorite seed for now")
        return

    favorite = Bookmark(
        bookmark_type=BookmarkType.FAVORITE.value,
        title="Welcome",
        source="onboarding",
        data={
            "entity_type": "markdown",
            "entity_id": str(welcome.typeid),
            "icon": "BookOpen",
            # The favorite click handler reads asset_ref from data.nav and
            # routes directly, bypassing a name-resolution hop on click.
            "nav": {"asset_ref": welcome.asset_ref or ""},
        },
    )
    await favorite.save(owner=user)

    user.onboarded = True
    await user.save()
    logging.info(f"[bootstrap] Seeded Welcome favorite for user {user.typeid}")


# ---------------------------------------------------------------------------
# File system setup (migrated from desktop_loader.py:init_desktop_entities)
# ---------------------------------------------------------------------------


def setup_desktop_filesystem() -> None:
    """Create desktop filesystem structure (.flow/logs, .flow/system_skills, settings.json).

    Sets up the workspace directory tree at ~/Flowpad workspace/:
      - .claude/skills/         (skills folder)
      - .flow/logs/             (log files)
      - .flow/system_skills/    (system skills -- copied from source if available)
      - .flow/settings.json     (default settings)

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_desktop_entities)
    """
    workspace_path = Path(AGENT_MOUNT_FOLDER)

    # Create skills folder structure if it doesn't exist
    skills_path = workspace_path / ".claude" / "skills"
    try:
        skills_path.mkdir(parents=True, exist_ok=True)
        logging.info(f"Skills folder ensured at: {skills_path}")
    except Exception as e:
        logging.warning(f"Failed to create skills folder: {e}")

    # Create logs folder structure under the per-instance logs dir.
    from flow_sdk.instance_settings import get_instance_settings
    logs_base = get_instance_settings().logs_dir
    for subdir in ("server", "monitor", "main_desktop"):
        try:
            (logs_base / subdir).mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logging.warning(f"Failed to create logs subdirectory {subdir}: {e}")
    logging.info(f"Logs folder ensured at: {logs_base}")

    # Create settings.json with defaults (only if file doesn't exist)
    settings_path = workspace_path / ".flow" / "settings.json"
    try:
        if not settings_path.exists():
            default_settings = {"show_system_skills": True}
            settings_path.write_text(json.dumps(default_settings, indent=2))
            logging.info(f"Settings file created at: {settings_path}")
        else:
            logging.info(f"Settings file already exists at: {settings_path}")
    except Exception as e:
        logging.warning(f"Failed to create settings file: {e}")


# ---------------------------------------------------------------------------
# Desktop info assembly (migrated from desktop_loader.py:get_desktop_info)
# ---------------------------------------------------------------------------


async def get_desktop_info() -> LmInfo:
    """Get desktop environment information including available LLM providers,
    installed agents, and cloud login status.

    Returns:
        LmInfo object with detected LLM providers, installed agents, and cloud login availability

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py
    """
    from flow_sdk.cloud_client import ApiConfig

    llm_providers = detect_available_llm_providers()
    installed_agents = await asyncio.to_thread(get_installed_agents)
    cloud_login_available = await is_cloud_login_available()

    # Build fully resolved paths
    app_paths = build_app_paths()

    return LmInfo(
        llm_providers=llm_providers,
        installed_agents=installed_agents,
        cloud_login_available=cloud_login_available,
        cloud_url=ApiConfig.from_env().api_base_url,
        paths=app_paths,
        # Legacy fields for backward compatibility (deprecated)
        home=get_vfs_home_path(),
        workspace="Flowpad workspace",
        skills=".claude/skills",
        logs=".flow/logs",
    )


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def entity_to_dict(entity) -> dict:
    """Convert entity to dict for JSON response."""
    return {
        "id": entity.id,
        "type": entity.type,
        "uname": entity.uname,
        "name": getattr(entity, "name", None) or getattr(entity, "title", None),
        "visitor_role": entity.visitor_role,
    }


# ---------------------------------------------------------------------------
# Bootstrap endpoint
# ---------------------------------------------------------------------------

# Serializes concurrent bootstrap calls: only one runs at a time; others wait
# and return the cached result. TTL of 30s allows a fresh bootstrap if the
# server has been running a while (e.g. after a plugin install).
_bootstrap_lock = asyncio.Lock()
_bootstrap_cache: BootstrapInfo | None = None
_bootstrap_cache_ts: float = 0.0
_BOOTSTRAP_CACHE_TTL = 30.0  # seconds


def invalidate_bootstrap_cache() -> None:
    """Reset the bootstrap cache so the next call runs a full bootstrap.

    Call this after wiping the database so the @local entities are recreated
    on the very next bootstrap request rather than returning stale entity IDs
    from the pre-wipe cache.
    """
    global _bootstrap_cache, _bootstrap_cache_ts
    _bootstrap_cache = None
    _bootstrap_cache_ts = 0.0


@router.get("/api/v1/graph/bootstrap")
async def bootstrap() -> ApiSuccessResponse[BootstrapInfo]:
    """
    Bootstrap endpoint - creates local entities and returns BootstrapInfo.

    This is called by the UI SDK (initSdk) on application startup.
    It initializes the local database, creates the desktop filesystem structure,
    and creates default @local entities.

    Concurrent calls are serialized: the first call runs the full bootstrap,
    subsequent concurrent calls wait and return the cached result. Cache TTL
    is 30 seconds.

    Migrated from FlowPad: flowpad/hub/core/desktop_loader.py (init_desktop_entities)
    and flowpad/hub/app/actions/bootstrap_actions.py (bootstrap action).

    Returns:
        ApiSuccessResponse containing BootstrapInfo with env, desktop_info, user, project, workspace, agent
    """
    global _bootstrap_cache, _bootstrap_cache_ts

    # Fast path: return cached result without acquiring the lock
    if _bootstrap_cache is not None and time.monotonic() - _bootstrap_cache_ts < _BOOTSTRAP_CACHE_TTL:
        return ApiSuccessResponse[BootstrapInfo](data=_bootstrap_cache)

    async with _bootstrap_lock:
        # Re-check inside the lock (another coroutine may have just finished)
        if _bootstrap_cache is not None and time.monotonic() - _bootstrap_cache_ts < _BOOTSTRAP_CACHE_TTL:
            return ApiSuccessResponse[BootstrapInfo](data=_bootstrap_cache)

        from flow_sdk.utils import TimeIt  # noqa: PLC0415
        _t = TimeIt("Bootstrap")

        # Initialize database (creates tables if needed)
        await init_db()
        _t.time("init_db")

        # Set up desktop filesystem (.flow/logs, .flow/system_skills, settings.json)
        await asyncio.to_thread(setup_desktop_filesystem)
        _t.time("setup_desktop_filesystem")

        # Get or create local entities using Entity API
        # Order matters: user first (owner), then project, workspace, compute node
        user = await get_or_create_local_user()
        _t.time("get_or_create_local_user")
        project = await get_or_create_local_project(desktop_user=user)
        _t.time("get_or_create_local_project")
        try:
            await _ensure_system_projects(desktop_user=user)
        except Exception as e:
            logging.warning(f"[bootstrap] Failed to ensure system projects (non-fatal): {e}")
        _t.time("ensure_system_projects")
        try:
            await _ensure_welcome_favorite(user)
        except Exception as e:
            logging.warning(f"[bootstrap] Failed to seed Welcome favorite (non-fatal): {e}")
        _t.time("ensure_welcome_favorite")
        workspace = await get_or_create_local_workspace(desktop_user=user)
        _t.time("get_or_create_local_workspace")
        compute_node = await get_or_create_local_compute_node(local_project=project, desktop_user=user)
        _t.time("get_or_create_local_compute_node")

        sandbox_available = is_sandbox_available()
        sandbox_compute_node: Optional[ComputeNode] = None
        if sandbox_available:
            try:
                sandbox_compute_node = await get_or_create_sandbox_compute_node(
                    local_project=project, desktop_user=user
                )
            except Exception as e:
                logging.warning(f"[bootstrap] Failed to create @sandbox compute node: {e}")
                sandbox_available = False
        _t.time("get_or_create_sandbox_compute_node")

        # Docker: one @docker-<name> CN per live worker. No env gate — only the
        # presence of a registered worker in docker_registry flips availability.
        try:
            docker_cns = await get_docker_compute_nodes()
        except Exception as e:
            logging.warning(f"[bootstrap] Failed to list docker compute nodes: {e}")
            docker_cns = []
        docker_available = len(docker_cns) > 0
        _t.time("get_docker_compute_nodes")

        # Get desktop info (LLM providers, installed agents, paths)
        desktop_info = await get_desktop_info()
        _t.time("get_desktop_info")

        # Get scan info (index status; queries DB for live entity counts).
        from flow_sdk.system_tools import get_scan_info  # noqa: PLC0415
        scan_info = await get_scan_info()
        _t.time("get_scan_info")

        # Auto-enable sniffer hook on desktop init.
        # Skip setup if already enabled — one read, zero writes on subsequent boots.
        from flow_sdk.app.actions.hooks_sniffer import _create_or_update_sniffer_hook, _get_sniffer_hook  # noqa: PLC0415
        sniffer_hook = None
        try:
            sniffer_hook = await _get_sniffer_hook()
            _t.time("get_sniffer_hook")
            if not sniffer_hook or not sniffer_hook.enabled:
                sniffer_hook = await _create_or_update_sniffer_hook(user)
                _t.time("create_or_update_sniffer_hook")
                await sniffer_hook.apply()
                _t.time("sniffer_hook.apply")
        except Exception as e:
            logging.warning(f"Failed to auto-enable sniffer hook: {e}")

        # Build BootstrapInfo using Pydantic model
        schemas = get_public_schema()
        _t.time("get_public_schema")
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
        bootstrap_info = BootstrapInfo(
            schemas=schemas,
            user=entity_to_dict(user),
            domain=None,
            visitor=None,
            default_project=entity_to_dict(project),
            default_workspace=entity_to_dict(workspace),
            default_compute_node=entity_to_dict(compute_node),
            sandbox_available=sandbox_available,
            sandbox_compute_node=entity_to_dict(sandbox_compute_node) if sandbox_compute_node else None,
            docker_available=docker_available,
            docker_compute_nodes=[entity_to_dict(cn) for cn in docker_cns],
            env=EnvInfo(env_name="desktop", cloud_api_url=os.environ.get("FLOWPAD_CLOUD_API_URL"), version=__version__),
            desktop_info=desktop_info,
            scan_info=scan_info,
            sniffer_hook=entity_to_dict(sniffer_hook) if sniffer_hook else None,
            records_root=str(get_instance_settings().records_root),
        )

        _t.done(0.5)

        _bootstrap_cache = bootstrap_info
        _bootstrap_cache_ts = time.monotonic()

    return ApiSuccessResponse[BootstrapInfo](data=_bootstrap_cache)
