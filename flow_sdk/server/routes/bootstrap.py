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
    ComputeProviderType,
    StorageProvider,
    get_os_root_path,
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
    root = get_os_root_path()
    # Get home path relative to root (strip leading slash for VFS)
    home_abs = str(Path.home())
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
    system_skills = f"{workspace}/.flow/system_assets/skills"
    system_agents = f"{workspace}/.flow/system_assets/agents"
    logs = f"{home}/.flow/logs"
    settings = f"{workspace}/.flow/settings.json"

    return AppPaths(
        root=root,
        home=home,
        workspace=workspace,
        skills=skills,
        user_skills=user_skills,
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
    """Check if cloud login is available by checking stored credentials."""
    try:
        from flow_sdk.cli.auth import is_logged_in
        return await asyncio.to_thread(is_logged_in)
    except Exception:
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
        logging.info(f"Desktop user already exists: {desktop_user.id} ({desktop_user.email})")
        return desktop_user

    # Also check by uname for backward compatibility with pre-migration entities
    existing_by_uname = await get_local_entity(User)
    if existing_by_uname:
        # Ensure it has the desktop label
        if DESKTOP_LABEL not in (existing_by_uname.labels or []):
            existing_by_uname.add_label(DESKTOP_LABEL)
            await existing_by_uname.save()
        # Update email/name if still defaults
        if existing_by_uname.name == "Local Desktop User" or not existing_by_uname.email:
            email = await asyncio.to_thread(get_email) or get_default_desktop_email()
            name = email.split("@")[0].replace(".", " ").title()
            existing_by_uname.email = email
            existing_by_uname.name = name
            await existing_by_uname.save()
            logging.info(f"Updated @local user with email: {email}, name: {name}")
        return existing_by_uname

    # Create new desktop user
    email = await asyncio.to_thread(get_email)
    if not email:
        email = get_default_desktop_email()
        logging.info(f"No email found for desktop user, using default: {email}")

    # Extract name from email (before @)
    name = email.split("@")[0].replace(".", " ").title()

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
            compute_node.node_provider_id = "name_" + str(uuid.uuid4())
            await compute_node.save()
            logging.info(f"@local compute node initialized with provider_id: {compute_node.node_provider_id}")
        except Exception as e:
            logging.warning(f"Failed to initialize @local compute node provider_id: {e}")

    return compute_node


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# File system setup (migrated from desktop_loader.py:init_desktop_entities)
# ---------------------------------------------------------------------------


def _copy_system_assets(workspace_path: Path) -> None:
    """Copy SDK-bundled system assets to workspace/.flow/system_assets/.

    Uses shutil.copytree with dirs_exist_ok=True so new assets are
    added on upgrade without deleting user modifications.
    Source: flow_sdk/system_assets/
    Destination: ~/Flowpad workspace/.flow/system_assets/

    A stamp file (.sync_stamp) stores the SDK version last synced.
    Re-copy is skipped when the stamp matches the current version.

    Also ensures backward-compat system_skills dir exists (symlink or plain dir).
    """
    import flow_sdk

    source = Path(flow_sdk.__file__).parent / "system_assets"
    dest = workspace_path / ".flow" / "system_assets"
    stamp = dest / ".sync_stamp"

    if source.exists():
        # Skip copy if already synced for this version
        try:
            if stamp.exists() and stamp.read_text().strip() == __version__:
                logging.info(f"System assets already up-to-date (v{__version__}), skipping copy")
            else:
                shutil.copytree(str(source), str(dest), dirs_exist_ok=True)
                stamp.write_text(__version__)
                logging.info(f"System assets copied to: {dest}")
        except Exception as e:
            logging.warning(f"Failed to copy system assets: {e}")
    else:
        dest.mkdir(parents=True, exist_ok=True)
        logging.info(f"System assets dir ensured at: {dest} (no bundled source)")

    # Ensure backward-compat system_skills path exists
    system_skills_path = workspace_path / ".flow" / "system_skills"
    skills_source = dest / "skills"
    if not system_skills_path.exists():
        if skills_source.is_dir():
            try:
                system_skills_path.symlink_to(skills_source)
                logging.info(f"Symlinked system_skills -> {skills_source}")
            except OSError:
                # Symlinks may fail on some Windows configs; just mkdir
                system_skills_path.mkdir(parents=True, exist_ok=True)
                logging.info(f"System skills folder ensured at: {system_skills_path}")
        else:
            system_skills_path.mkdir(parents=True, exist_ok=True)
            logging.info(f"System skills folder ensured at: {system_skills_path}")


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

    # Create logs folder structure under ~/.flow/logs/
    logs_base = Path.home() / ".flow" / "logs"
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
    llm_providers = detect_available_llm_providers()
    installed_agents = await asyncio.to_thread(get_installed_agents)
    cloud_login_available = await is_cloud_login_available()

    # Build fully resolved paths
    app_paths = build_app_paths()

    return LmInfo(
        llm_providers=llm_providers,
        installed_agents=installed_agents,
        cloud_login_available=cloud_login_available,
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

        # One-time migration: delete all legacy Asset entities
        try:
            from flow_sdk.core.entity.entity_model import Entity as _Entity  # noqa: PLC0415
            _asset_entities = await _Entity.get_all({"type": "asset"})
            for _ae in _asset_entities:
                try:
                    await _ae.delete()
                except Exception:
                    pass
            if _asset_entities:
                logging.info(f"[bootstrap] Cleaned up {len(_asset_entities)} legacy Asset entities")
        except Exception as _e:
            logging.warning(f"[bootstrap] Asset cleanup failed (non-fatal): {_e}")
        _t.time("cleanup_asset_entities")

        # Set up desktop filesystem (.flow/logs, .flow/system_skills, settings.json)
        await asyncio.to_thread(setup_desktop_filesystem)
        _t.time("setup_desktop_filesystem")

        # Get or create local entities using Entity API
        # Order matters: user first (owner), then project, workspace, compute node
        user = await get_or_create_local_user()
        _t.time("get_or_create_local_user")
        project = await get_or_create_local_project(desktop_user=user)
        _t.time("get_or_create_local_project")
        workspace = await get_or_create_local_workspace(desktop_user=user)
        _t.time("get_or_create_local_workspace")
        compute_node = await get_or_create_local_compute_node(local_project=project, desktop_user=user)
        _t.time("get_or_create_local_compute_node")

        # Get desktop info (LLM providers, installed agents, paths)
        desktop_info = await get_desktop_info()
        _t.time("get_desktop_info")

        # Get scan info (index status, no DB query needed)
        from flow_sdk.system_tools import get_scan_info  # noqa: PLC0415
        scan_info = get_scan_info()
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
        bootstrap_info = BootstrapInfo(
            schemas=schemas,
            user=entity_to_dict(user),
            domain=None,
            visitor=None,
            default_project=entity_to_dict(project),
            default_workspace=entity_to_dict(workspace),
            default_compute_node=entity_to_dict(compute_node),
            env=EnvInfo(env_name="desktop", cloud_api_url=os.environ.get("FLOWPAD_CLOUD_API_URL"), version=__version__),
            desktop_info=desktop_info,
            scan_info=scan_info,
            sniffer_hook=entity_to_dict(sniffer_hook) if sniffer_hook else None,
        )

        _t.done(0.5)

        _bootstrap_cache = bootstrap_info
        _bootstrap_cache_ts = time.monotonic()

    return ApiSuccessResponse[BootstrapInfo](data=_bootstrap_cache)
