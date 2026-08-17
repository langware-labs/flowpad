"""Configuration module for Flow SDK.

Defines ServiceConfig with environment variable support and SOD provider settings.
Migrated from flowpad/config.py — types, enums, constants, and models brought as-is
for API wire compatibility. Cloud-only logic (GCP secret loading, init_env) is skipped.
"""

import logging
import os
import re
import string
import sys
import tempfile
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from flow_sdk._compat import StrEnum
from flow_sdk.utils.validation import UUID_PATTERN

# ---------------------------------------------------------------------------
# URL constants
# ---------------------------------------------------------------------------

FLOWPAD_CLOUD_URL = "https://app.flowpad.ai"
API_PREFIX = "/api/v1"

# ---------------------------------------------------------------------------
# Path getters — call-time, via InstanceSettings (single source of truth).
# Direct `Path.home() / ".flow" / X` constructions are a contract violation.
# ---------------------------------------------------------------------------


def _flow_home() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().flow_home


def _server_json_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().server_json_path


# ---------------------------------------------------------------------------
# System projects (shipped inside the flow_sdk package)
# ---------------------------------------------------------------------------

SYSTEM_PROJECTS_DIRNAME = "system_projects"
FLOWPAD_ASSISTANT_DIRNAME = "flowpad_assistant"
FLOWPAD_ASSISTANT_PROJECT_UNAME = "flowpad_assistant"
FLOWPAD_ASSISTANT_PROJECT_NAME = "Flowpad Assistant"


def system_projects_root() -> Path:
    """Filesystem root containing all SDK-shipped system projects."""
    import importlib.resources

    return Path(str(importlib.resources.files("flow_sdk") / SYSTEM_PROJECTS_DIRNAME))


def flowpad_assistant_project_root() -> Path:
    """Mount path for the Flowpad Assistant system project."""
    return system_projects_root() / FLOWPAD_ASSISTANT_DIRNAME


@lru_cache(maxsize=1)
def flowpad_assistant_canonical_root() -> str | None:
    """Canonical posix path of the running install's assistant project, or None.

    The string form of ``flowpad_assistant_project_root()``, resolved the same
    way ``indexer.roots.classify_path`` resolves it when stamping
    ``entity.scope == "system"`` — so a scope tag and a path prefix can be
    compared. Callers that need to answer "is this path the assistant's?" want
    this, not ``is_system_project_path`` (which matches ANY install structurally).
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    try:
        return canonical_posix_path(flowpad_assistant_project_root().resolve())
    except (OSError, ValueError):
        return None


def is_system_project_path(path: str | Path) -> bool:
    """True when ``path`` is an SDK-shipped system project dir, for ANY install.

    ``system_projects_root()`` resolves to the CURRENTLY-RUNNING SDK, so it
    can't recognise the same shipped project under a different install (an
    editable checkout vs. a wheel, or an older interpreter's site-packages).
    Those copies get their own Project entities — minted per cwd off worker
    session history — and only the running one carries ``system=True`` from
    ``_ensure_system_projects``. Systemness is a property of the LOCATION, so
    match it structurally: ``<any-install>/flow_sdk/system_projects/<name>``.
    """
    p = Path(path)
    return p.parent.name == SYSTEM_PROJECTS_DIRNAME and p.parent.parent.name == "flow_sdk"


def _active_server_json_path() -> Path:
    """Per-instance server.json path. InstanceSettings handles the dev/prod split."""
    return _server_json_path()


# SDK repo root and UI build output
_SDK_PKG_DIR = Path(__file__).resolve().parent  # .../flow-cli/flow_sdk/
REPO_ROOT = _SDK_PKG_DIR.parent  # .../flow-cli/
UI_DIST = REPO_ROOT / "ui" / "dist"

STORAGE_FOLDER_DATE_FORMAT = "%Y-%m-%d-%H-%M-%S"
TEST_STORAGE_CLEAR_TIMEOUT_SEC = 30 * 60

# Platform constants for sys.platform comparisons
PLATFORM_WIN32 = "win32"
PLATFORM_DARWIN = "darwin"
PLATFORM_WIN_PREFIX = "win"  # For startswith checks (matches win32, win64, etc.)

# Platform constants for platform.system().lower() comparisons
PLATFORM_WINDOWS = "windows"
PLATFORM_LINUX = "linux"
# Note: PLATFORM_DARWIN works for both sys.platform and platform.system().lower()

# Environment variable names
ENV_DESKTOP_DB = "DESKTOP_DB"
ENV_SQLITE_DATABASE_PATH = "SQLITE_DATABASE_PATH"
ENV_FS_RECORD_PATH = "FS_RECORD_PATH"


# ---------------------------------------------------------------------------
# Enums (brought as-is from FlowPad for API wire compatibility)
# ---------------------------------------------------------------------------


class PublicApiPaths(StrEnum):
    """Public API paths that bypass auth in FlowPad.
    In flow-cli all routes are public, but this enum is kept for wire compat.
    """

    FAVICON = "favicon.ico"
    HEALTH = "health"
    SIGNUP = "signup"
    LOGIN = "login"
    VISIT = "visit"
    TEST = "test"
    BOOTSTRAP = "bootstrap"
    REDIRECT = "redirect"
    REFRESH_TOKEN = "refresh-token"
    CALLBACK = "callback"
    LOGOUT = "logout"
    CURRENT_USER = "current-user"
    EMAIL_VERIFICATION = "email-verification"
    WORK_EMAIL_ERROR = "work-email-error"
    CONNECT_WS = "connect/ws"
    WEBHOOK = "webhook"
    SCHEMA = "public_schema"
    SKILLS = "skills"


class DeployEnv(str, Enum):
    """Deployment environment types."""

    DESKTOP = "desktop"
    LOCAL = "local"
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class SodProvider(str, Enum):
    """Secure Object Database (SOD) provider types."""

    DEV_FILE = "dev_file"  # Local file storage (development only)
    GCP = "gcp"  # Google Cloud Secret Manager (production)


class StorageProvider(StrEnum):
    """Storage provider types for file system operations."""

    LOCAL = "local"
    S3 = "s3"
    AZURE = "azure"
    GCS = "gcs"
    SFTP = "sftp"
    SANDBOX = "sandbox"


class EmailProviderType(StrEnum):
    """How the system SENDS mail (notifications, invitations)."""

    MOCK = "mock"


class EmailInboxProviderType(StrEnum):
    """Where an AGENT's own mailbox lives.

    Separate from :class:`EmailProviderType` for the reason the hub states on
    its own matching pair: the system sender and an agent's inbox are different
    capabilities, configured independently. Collapsing them means one field with
    two meanings, and a value valid for one is a hard failure for the other.

    Each value must be a REGISTERED driver kind in
    ``flow_sdk/builtin/email_inbox_driver.py`` — an unregistered one raises at
    the first mailbox call, not at startup. ``flowpad-hub`` matches
    ``HubSecretDriver``'s kind so the two families spell "the hub" the same way.
    """

    HUB = "flowpad-hub"


class ComputeProviderType(StrEnum):
    """Compute provider types."""

    LOCAL = "local"
    LOCAL_MACHINE = "local_machine"
    GCP = "gcp"
    AWS = "aws"
    E2B = "e2b"
    # This machine, enrolled on the hub with `flow connect` (hub-side provider name).
    USER_MACHINE = "user_machine"


class DBDriver(StrEnum):
    """Database driver types."""

    SQLITE = "sqlite"
    NEO4J = "neo4j"
    NETWORKX = "networkx"


class AuthProviderType(StrEnum):
    """Authentication provider types."""

    AUTH0 = "auth0"
    CUSTOM = "custom"


# ---------------------------------------------------------------------------
# OS root path utility
# ---------------------------------------------------------------------------


def get_os_root_path() -> str:
    """Returns filesystem root path for current platform."""
    return "/" if sys.platform != PLATFORM_WIN32 else "C:\\"


# ---------------------------------------------------------------------------
# Temp directory management
# ---------------------------------------------------------------------------

FLOWPAD_TEMP_DIR: str = os.getenv(key="FLOWPAD_TEMP_DIR", default="")


def init_temp_dir():
    """
    Initialize the temporary directory for Flowpad.

    This function creates a temporary directory in the system's temp folder
    specifically for Flowpad, and cleans it up if it already exists.
    """
    global FLOWPAD_TEMP_DIR
    if FLOWPAD_TEMP_DIR:
        logging.info(f"Temporary directory already set: {FLOWPAD_TEMP_DIR}")
    else:
        FLOWPAD_TEMP_DIR = str(Path(tempfile.gettempdir()) / "flowpad_temp")
        logging.info(f"Using temporary directory: {FLOWPAD_TEMP_DIR}")

    # Create the temp directory
    os.makedirs(FLOWPAD_TEMP_DIR, exist_ok=True)


init_temp_dir()


# ---------------------------------------------------------------------------
# User desktop data folder
# ---------------------------------------------------------------------------


def get_user_desktop_data_folder() -> Path:
    """
    Get the OS-specific user data folder for FlowPad desktop application.

    Returns:
        Path to the user data folder:
        - macOS: ~/Library/Application Support/FlowPad/
        - Windows: %APPDATA%/FlowPad/
        - Linux: ~/.config/FlowPad/
    """
    if sys.platform == "darwin":  # macOS
        base_path = Path.home() / "Library" / "Application Support"
    elif sys.platform.startswith("win"):  # Windows
        base_path = Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:  # Linux and other Unix-like systems
        base_path = Path.home() / ".config"

    user_data_folder = base_path / "FlowPad"

    # Create the folder if it doesn't exist
    user_data_folder.mkdir(parents=True, exist_ok=True)

    return user_data_folder


# ---------------------------------------------------------------------------
# Server info (server.json for external tools like Claude Code hooks)
# ---------------------------------------------------------------------------


def get_port_file_path() -> Path:
    """Get path to active server JSON file (dev or prod)."""
    return _active_server_json_path()


class FlowpadServerInfo(BaseModel):
    """Server connection info written to server.json for external tools."""

    port: int
    webhook_path: str = "/api/v1/webhook/listen"
    health_path: str = "/api/v1/health/status"
    url: str = ""
    server_pid: int | None = None
    monitor_pid: int | None = None
    launch_iso_time: str | None = None  # ISO 8601


def load_server_info() -> dict:
    """Read ~/.flow/server.json, return empty dict if missing/corrupt."""
    import json

    port_file = get_port_file_path()
    if not port_file.exists():
        return {}
    try:
        return json.loads(port_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def save_server_info(data: dict) -> Path:
    """Atomic write: temp file + rename to prevent corruption."""
    import json

    port_file = get_port_file_path()
    port_file.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = port_file.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, indent=2))
    os.replace(str(tmp_path), str(port_file))
    return port_file


def write_server_info(port: int) -> Path:
    """Write server.json with connection info for external tools.

    Args:
        port: The port the server is running on.

    Returns:
        Path to the written server.json file.
    """
    data = load_server_info()
    data.update(
        {
            "port": port,
            "webhook_path": "/api/v1/webhook/listen",
            "health_path": "/api/v1/health/status",
        }
    )
    return save_server_info(data)


def set_server_info(data: dict) -> Path:
    """Merge-write data into the active server json (dev or prod). Atomic."""
    existing = load_server_info()
    existing.update(data)
    return save_server_info(existing)


def clear_server_info() -> None:
    """Delete the active server.json — this server is no longer running.

    Every key in the file is runtime-only (port, pids, launch time), and a
    leftover file is actively harmful: broadcast readers (``flow hooks
    report``) treat any server.json as a live target, so a stale one
    re-routes their traffic to whichever server later recycles the port.
    """
    try:
        get_port_file_path().unlink(missing_ok=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Agent mount folder
# ---------------------------------------------------------------------------


def get_agent_mount_folder() -> str:
    """
    Get the agent mount folder based on deployment environment.

    Returns:
        Path to the agent mount folder:
        - Desktop/Local mode: User home / "Flowpad workspace"
        - Other modes: FLOWPAD_TEMP_DIR/flowpad_sandbox
    """
    # Desktop-only in flow-cli, always return user home workspace
    agent_folder = Path.home() / "Flowpad workspace"
    agent_folder.mkdir(parents=True, exist_ok=True)
    return str(agent_folder)


# Agent mount folder constant
AGENT_MOUNT_FOLDER = get_agent_mount_folder()


def agent_workspace_root() -> Path:
    """Per-instance agent mount ROOT (``<user_home>/Flowpad workspace``).

    Matches the folder scanned by ``iter_workspace_project_paths`` and used as
    the default agent working directory, resolved through instance settings so a
    named dev instance points at its own home rather than ``Path.home()``.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().user_home / "Flowpad workspace"


# ---------------------------------------------------------------------------
# Help-desk portal checkouts
# ---------------------------------------------------------------------------

# Dot-dir INSIDE the workspace, deliberately: it inherits the workspace's
# per-instance home (so dev-1 and dev-2 never share a checkout), stays out of
# the user's visible project area, and — being a DESCENDANT of the mount root
# rather than the root itself — is not `is_protected_path`, which is what lets
# the dev reset delete it. See `helpdesk_project_dir`.
HELPDESK_DIRNAME = "helpdesk"

# Stable uname for the local portal Project. Lets any surface answer "is this
# the helpdesk portal?" from the entity already in hand — no request, the same
# `@uname` convention the Flowpad Assistant uses.
HELPDESK_PORTAL_UNAME = "helpdesk_portal"


def helpdesk_root() -> Path:
    """Root holding every helpdesk portal checkout on this instance.

    ``<agent workspace>/.flow/helpdesk``. Built with ``pathlib`` so it is
    correct on Windows as well as POSIX; callers that STORE the result (e.g.
    ``Project.fs_storage_mount_path``) must pass it through
    ``canonical_posix_path`` first, like every other stored path.
    """
    return agent_workspace_root() / ".flow" / HELPDESK_DIRNAME


def helpdesk_project_dir(helpdesk_project_id: str) -> Path:
    """Checkout slot for one desk's portal, keyed by its HUB project id.

    Keying on the desk's hub id (not the local Project id) makes the path
    deterministic before the local entity exists, and gives each tier of a
    support chain its own slot without collision.
    """
    return helpdesk_root() / f"project-{helpdesk_project_id}"


def is_helpdesk_portal_path(cwd: str | Path) -> bool:
    """True when ``cwd`` is a helpdesk portal checkout.

    A LOCATION test, matching ``is_system_project_path`` / ``is_agent_mount_root``:
    the portal is app-managed infrastructure rather than one of the user's
    projects, and that is a property of where it lives. Deriving hiddenness from
    the path (instead of stamping ``system=True`` on the entity, which means
    "SDK-shipped" and would be a lie here) also covers rows minted by the
    per-cwd project walk, which never sets that flag.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under  # noqa: PLC0415

    try:
        # The ROOT goes through the cached canonicalizer, like `is_agent_mount_root`
        # does: `is_hidden_project` calls this once per project in a list, and
        # `helpdesk_root()` reaches instance settings, so re-resolving it per
        # project made an almost-always-false check the expensive arm of the chain.
        roots = _canonical_mount_roots(str(helpdesk_root()))
        return any(is_path_under(canonical_posix_path(cwd), root) for root in roots)
    except (OSError, ValueError):
        return False


@lru_cache(maxsize=8)
def _canonical_mount_roots(*raw_roots: str) -> frozenset[str]:
    """Canonical forms of the agent mount roots, cached per distinct value pair.

    Keyed on the raw root strings so a test that monkeypatches the roots gets its
    own cache entry (no stale/leaked value), while a real scan resolves each root
    once instead of re-running ``Path.resolve()`` for every cwd in the loop.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    out: set[str] = set()
    for raw in raw_roots:
        try:
            out.add(canonical_posix_path(raw))
        except (OSError, ValueError):
            continue
    return frozenset(out)


def is_agent_mount_root(path: str | Path) -> bool:
    """True when ``path`` is the agent mount ROOT itself — never a project.

    The mount root is the container where agentic processes do their work; it is
    infrastructure, not a user project. Without this gate, agentic-process init
    (``Project.recover_by_path``) mints a stray "Flowpad workspace" project the
    first time a process runs at the root with no specific project bound. Only
    the bare root is excluded — real work subfolders under it stay projects.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    try:
        target = canonical_posix_path(path)
    except (OSError, ValueError):
        return False
    return target in _canonical_mount_roots(AGENT_MOUNT_FOLDER, str(agent_workspace_root()))


def is_hidden_project(cwd: str | Path, system_flag: bool = False) -> bool:
    """True when a project should be hidden from the default project lists.

    A project is hidden when it is an SDK-shipped system project, the agent
    mount ROOT (``~/Flowpad workspace``), or a helpdesk portal checkout. The
    path checks route through the workspace consts (``is_system_project_path``
    / ``is_agent_mount_root`` / ``is_helpdesk_portal_path``) — never a
    hardcoded literal. Hidden projects are still revealable via the "Show
    system projects" preference, which flips the ``system`` filter off.
    """
    return system_flag or is_system_project_path(cwd) or is_agent_mount_root(cwd) or is_helpdesk_portal_path(cwd)


# ---------------------------------------------------------------------------
# Service URL configuration
# ---------------------------------------------------------------------------


class ServiceUrlsConfig(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # Simple port configuration (loaded from environment)
    backend_scheme: str = "http"
    backend_host: str = "localhost"
    backend_port: int | None = Field(default=None, alias="LOCAL_SERVER_PORT")
    frontend_scheme: str = "http"
    frontend_host: str = "localhost"
    frontend_port: int | None = Field(default=None, alias="VITE_PORT")
    frontend_proxy_port: int = 5174

    # Legacy URL configuration (for backwards compatibility)
    vfs_path_prefix: str = ""
    static_path_prefix: str = ""

    # Computed properties - built from simple port config
    @property
    def api_url(self) -> str:
        if not self.backend_port:
            return f"{self.api_url_scheme}://{self.backend_host}"
        return f"{self.api_url_scheme}://{self.backend_host}:{self.backend_port}"

    @property
    def app_url(self) -> str:
        if not self.frontend_port:
            return f"{self.app_url_scheme}://{self.frontend_host}"
        return f"{self.app_url_scheme}://{self.frontend_host}:{self.frontend_port}"

    # Parsed URL components (computed properties)
    @property
    def api_url_scheme(self) -> str:
        return self.backend_scheme

    @property
    def api_hostname(self) -> str:
        return self.backend_host

    @property
    def api_port(self) -> int | None:
        return self.backend_port

    @property
    def api_netloc(self) -> str:
        if not self.backend_port:
            return self.backend_host
        return f"{self.backend_host}:{self.backend_port}"

    @property
    def app_url_scheme(self) -> str:
        return self.frontend_scheme

    @property
    def app_hostname(self) -> str:
        return self.backend_host

    @property
    def app_port(self) -> int | None:
        return self.backend_port

    @property
    def app_netloc(self) -> str:
        if not self.backend_port:
            return self.backend_host
        return f"{self.backend_host}:{self.backend_port}"

    @property
    def service_external_host(self) -> str:
        """
        Get the external/public API URL for compute nodes to use.
        Priority:
        1. If backend_host is a public domain (not localhost/127.0.0.1), use api_url
        2. Otherwise, check SERVICE_URLS_CONFIG__EXTERNAL_HOST env var
        3. Fallback to api_url
        """
        # Check if backend_host is already a public domain
        if self.backend_host not in ["localhost", "127.0.0.1", "0.0.0.0"]:
            # Already a public domain, use it
            return self.api_url

        # Check for external host override from environment
        external_host = os.getenv("SERVICE_URLS_CONFIG__EXTERNAL_HOST")
        if external_host:
            # Parse if it's a full URL or just hostname
            if external_host.startswith("http://") or external_host.startswith("https://"):
                return external_host
            else:
                # Just hostname, build URL with scheme
                scheme = os.getenv("SERVICE_URLS_CONFIG__EXTERNAL_SCHEME", "https")
                return f"{scheme}://{external_host}"

        # Fallback to regular api_url
        return self.api_url


# ---------------------------------------------------------------------------
# Micro app domain configuration
# ---------------------------------------------------------------------------


class MicroAppDomainConfig(BaseModel):
    pattern: re.Pattern | None = None
    view_action: str = "view"
    app_domain: str = "flowpad.app"
    port: int | None = None

    def __init__(self, **data):
        super().__init__(**data)
        # Build the pattern after the model is initialized
        self._build_subdomain_regex()

    def _build_subdomain_regex(self):
        """
        Builds a regex pattern to match subdomains of the given domain.
        """
        escaped_domain = re.escape(self.app_domain)  # safely escape dots, etc.
        pattern_string = f"^({UUID_PATTERN})\\.{escaped_domain}(?::\\d+)?$"
        self.pattern = re.compile(pattern_string)

    @property
    def _verified_pattern(self):
        if self.pattern is None:
            raise ValueError("Pattern is not built")
        return self.pattern

    def get_micro_app_id_from_host(self, host: str) -> str | None:
        _micro_app_host = self._verified_pattern.match(host)
        return _micro_app_host.group(1) if _micro_app_host else None

    def is_micro_app_host(self, host: str):
        return bool(self._verified_pattern.match(host))


# ---------------------------------------------------------------------------
# Main service configuration
# ---------------------------------------------------------------------------


class ServiceConfig(BaseSettings):
    """Service configuration loaded from environment variables.

    Migrated from FlowPad ServiceConfig. Desktop-only fields are kept for
    API wire compatibility; cloud-only features (GCP, E2B sandbox timeouts,
    email sending, knowledge engine tuning) use sensible desktop defaults.
    """

    model_config = SettingsConfigDict(
        env_nested_delimiter="__", nested_model_default_partial_update=True, case_sensitive=False
    )

    # Server
    host: str | None = None
    port: int | None = None
    version: str = "0.0.0"

    # Sub-configs
    micro_app_domain_config: MicroAppDomainConfig = MicroAppDomainConfig()
    service_urls_config: ServiceUrlsConfig = ServiceUrlsConfig()

    # Deployment
    staging_domain: str = "staging.example.com"
    deploy_env: DeployEnv = DeployEnv.DESKTOP
    env_file: str = ""
    char_set: str = string.ascii_lowercase + string.digits + string.ascii_uppercase + "@$!%*#?&"
    app_folder: str = ""
    datasets_folder: str = ""
    action_folders: list[str] = []
    policy_spec_path: str | None = None
    request_timeout: int = 120
    session_secret: str | None = None
    auth_provider: str = AuthProviderType.CUSTOM.value
    enable_refresh_token: bool = False
    job_provider: str = "local"

    # SOD (Secure Object Database) configuration
    sod_provider: str = SodProvider.DEV_FILE.value
    sod_file_name: str = "sod.local"
    sod_enc_key: str | None = None

    # Storage
    default_storage_provider: str = StorageProvider.LOCAL.value
    default_storage_id: str = "local_flowpad"
    default_storage_mount_folder: str = os.path.join(FLOWPAD_TEMP_DIR, ".flowpad_storage")
    local_temp_project_dir: str = os.path.join(FLOWPAD_TEMP_DIR, "flowpad_project")
    skills_sub_folder: str = os.path.join(".claude", "skills")
    e2b_sandbox_storage_mount_folder: str = "/home/user"
    local_sandbox_working_dir: str = os.path.join(FLOWPAD_TEMP_DIR, ".local_sandbox")

    # Compute
    default_compute_provider: ComputeProviderType = ComputeProviderType.LOCAL_MACHINE
    default_e2b_version: str = "v0-27-3"
    default_e2b_size: str = "sm"
    job_runner_type: Literal["local", "gcp"] = "local"
    mcp_connector_pool_size: int = 5

    # Email (stub for desktop)
    email_provider: str = EmailProviderType.MOCK.value
    #: Where an agent's mailbox is allocated — NOT the system sender above.
    email_inbox_provider: str = EmailInboxProviderType.HUB.value
    no_reply_email: str = "no-reply@example.com"
    flowpad_hub_url: str | None = None

    # Search / LLM
    google_search_url: str | None = None
    google_search_key: str | None = None
    google_search_context: str | None = None
    search_model: str = "openai/gpt-4o-mini"
    search_compression_model: str = "google/gemini-2.5-flash-lite"
    redact_tool_results_after_tokens: int = 200_000
    redact_tool_results_after_result_length: int = 1_000
    compress_write_file_after_tokens: int = 300_000
    compress_write_file_after_write_length: int = 1_000
    remove_middle_messages_after_count: int = 900
    flow_state_persistence_node_snapshots_length: int = 10
    search_results_compression_model_max_input_token: int = 1_000_000

    # External API keys
    google_cloud_project_id: str = ""
    google_cloud_project_location: str = "us-central1"
    google_anthropic_cloud_project_location: str = "us-east5"
    openai_api_key: str | None = None
    perplexity_api_key: str | None = None
    groq_api_key: str | None = None
    anthropic_api_key: str | None = None
    openrouter_api_key: str | None = None
    bedrock_aws_region_name: str = "us-east-1"
    bedrock_aws_access_key_id: str | None = None
    bedrock_aws_secret_access_key: str | None = None

    # E2B sandbox
    e2b_api_key: str | None = None
    e2b_sandbox_live_timeout: int = 60 * 30
    e2b_sandbox_pause_timeout: int = 60 * 3

    # LLM driver settings
    llm_driver: str = "vertexai"
    llm_fallback_drivers: list[str] = ["vertexai", "openai", "anthropic"]
    llm_cache_enabled: bool = False
    llm_generation_timeout: float = 120.0
    max_thinking_tokens: int = 1024
    embeddings_driver: str = "openai"
    embeddings_max_retries: int = 2

    # Knowledge engine settings (kept for wire compat)
    proxycurl_api_url: str | None = None
    proxycurl_api_key: str | None = None
    chunk_size: int = 8191
    vector_dimensions: int = 1536
    vector_similarity_function: str = "cosine"
    vector_num_of_results_multiplier: int = 2
    page_rank_threshold: float = 0.7
    knowledge_default_token_budget: int = 10000
    knowledge_default_characters_per_token: float = 4.0
    knowledge_default_num_of_results: int = 8
    knowledge_recent_num_of_results: int = 3
    knowledge_fulltext_score_threshold: float = 1.0
    knowledge_vector_score_threshold: float = 0.69
    ingestion_max_concurrency: int = 1
    deep_crawl_max_depth: int = 2
    deep_crawl_max_urls: int = 512

    # Misc flags
    lazy_warmup: bool = False
    login_cache_ttl: int = 0
    invitation_expires_in_days: int = 7
    is_package: bool = False
    development: bool = True
    hot_reload: bool = False
    local_user_allowed: str = "true"
    db_driver: str = DBDriver.SQLITE.value
    load_plugins: bool = False
    deep_testing: bool = False
    manual_testing: bool = False
    load_flowpad_assistant: bool = True

    # Paths
    public_static_paths: list[str] = [
        "/openapi.json",
        "/hub/openapi.json",
        "/docs",
        "/hub/docs",
    ]
    public_api_paths: list[str] = ["/" + path for path in PublicApiPaths.__members__.values()]
    local_run: str = "/login/local"
    default_action_methods: set = {"get"}
    json_indent_level: int = 2
    python_indent_level: int = 4

    # Auth cookies (kept for wire compat)
    token_cookie_name: str = "JWT"
    api_key_get_param_name: str = "flowpad-api-key"
    refresh_cookie_name: str = "JWT_REFRESH"
    visitor_cookie_name: str = "_vid"
    visitor_session_cookie_name: str = "_vid_session"

    # Feedback (kept for wire compat)
    feedback_dataset_file: Path = Path("feedback.csv")
    feedback_bucket: str = "chat_threads_with_feedback"
    feedback_gather_interval: int | float = 1

    # Observability
    logfire_token: str | None = None
    logfire_send_to_logfire: bool = False
    logfire_send_to_console: bool = False

    # Worker
    default_agent_worker: str = "pydantic_ai"

    @property
    def feedback_file_path(self) -> Path:
        return Path(self.datasets_folder) / Path(self.feedback_dataset_file)

    @property
    def hash(self):
        return str(hash(self.model_dump_json()))

    @property
    def is_local_or_development(self) -> bool:
        return self.deploy_env in [DeployEnv.LOCAL, DeployEnv.DEVELOPMENT]

    @property
    def is_local(self) -> bool:
        return self.deploy_env in [DeployEnv.LOCAL, DeployEnv.DESKTOP]

    @property
    def is_desktop(self) -> bool:
        return self.deploy_env == DeployEnv.DESKTOP

    @property
    def is_local_user_allowed(self) -> bool:
        return self.local_user_allowed.lower() in ["true", "sr"]

    @property
    def is_local_user_super_reader(self) -> bool:
        return self.local_user_allowed.lower() == "sr"

    @property
    def sandbox_storage_mount_path(self) -> str:
        return (
            self.local_sandbox_working_dir
            if self.default_compute_provider == ComputeProviderType.LOCAL_MACHINE
            else self.e2b_sandbox_storage_mount_folder
        )

    @property
    def skills_folder(self) -> str:
        """Path to the skills folder within the project directory."""
        return os.path.join(self.local_temp_project_dir, self.skills_sub_folder)

    def init_desktop_env(self):
        """
        Initialize desktop environment configuration.
        Sets database driver, compute provider, auth provider, and storage paths for desktop mode.
        """
        # Determine database driver from DESKTOP_DB env var
        desktop_db = os.getenv(ENV_DESKTOP_DB, DBDriver.SQLITE.value).lower()
        valid_drivers = [DBDriver.SQLITE.value, DBDriver.NEO4J.value, DBDriver.NETWORKX.value]

        if desktop_db in valid_drivers:
            self.db_driver = desktop_db
        else:
            logging.warning(
                f"[WARNING] Invalid DESKTOP_DB value '{desktop_db}'. "
                f"Valid options: {valid_drivers}. Defaulting to '{DBDriver.SQLITE.value}'."
            )
            self.db_driver = DBDriver.SQLITE

        # All per-instance paths come from InstanceSettings (single source of truth).
        # See flow_sdk/instance_settings/ — picks dev/test/prod based on env.
        from flow_sdk.instance_settings import get_instance_settings

        settings = get_instance_settings()

        # Configure SQLite-specific paths only when using SQLite.
        # InstanceSettings is the single source of truth — we ensure the
        # directories exist but never echo back into os.environ. Writing to
        # env at validator-time poisoned the SoT and caused the live
        # split-instance "database disk image is malformed" incident: the
        # validator fires at module-import time (before .env.local loads),
        # pinning SQLITE_DATABASE_PATH / FS_RECORD_PATH to whatever instance
        # the ambient env resolved to. Later readers re-read the poisoned
        # env and silently used the wrong instance's DB / records.
        if self.db_driver == DBDriver.SQLITE.value:
            settings.db_dir.mkdir(parents=True, exist_ok=True)
            db_info = f"SQLite at {settings.db_path}"
        else:
            db_info = f"{self.db_driver} database driver"

        settings.records_root.mkdir(parents=True, exist_ok=True)

        # Force local compute provider for desktop
        self.default_compute_provider = ComputeProviderType.LOCAL_MACHINE
        self.job_runner_type = "local"

        # Force custom auth provider for desktop
        self.auth_provider = AuthProviderType.CUSTOM

        return db_info

    @model_validator(mode="after")
    def apply_desktop_config(self):
        """
        Apply desktop-specific configurations after model initialization.
        """
        if self.is_desktop:
            db_info = self.init_desktop_env()
            user_data_folder = get_user_desktop_data_folder()

            # Configure desktop-specific storage paths
            self.default_storage_mount_folder = str(user_data_folder / "entity_storage")

            # Desktop always connects to production hub unless overridden by env var
            if not self.flowpad_hub_url:
                self.flowpad_hub_url = FLOWPAD_CLOUD_URL

            logging.info(
                f"[INFO] Desktop environment detected - using {db_info} and local storage at {user_data_folder}"
            )

        return self


# ---------------------------------------------------------------------------
# Module-level initialization
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# Global default service config instance
default_service_config: ServiceConfig = ServiceConfig()

# Debug log file path
debug_file_path = os.path.join(FLOWPAD_TEMP_DIR, "debug.log")

# Environment variable constants (for consumers that import these)
GOOGLE_APPLICATION_CREDENTIALS = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", None)
# Phase D: ``DEVELOPMENT = os.getenv("FLOWPAD_DEV", False)`` was dropped here.
# Callers route through ``get_instance_settings().is_dev`` (derived from
# instance_name). The legacy constant had a ``str|False`` type-inconsistency
# bug and no remaining external consumers — sqlite_driver imports its own
# local ``DEVELOPMENT`` from ``.connection``, not from this module.
