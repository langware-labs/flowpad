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
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from flow_sdk.utils.validation import UUID_PATTERN


# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

FLOW_HOME = Path.home() / ".flow"
SERVER_JSON_PATH = FLOW_HOME / "server.json"
DEV_SERVER_JSON_PATH = FLOW_HOME / "dev_server.json"


def _is_dev_mode() -> bool:
    return os.environ.get("FLOWPAD_DEV", "").lower() == "true"


def _active_server_json_path() -> Path:
    return DEV_SERVER_JSON_PATH if _is_dev_mode() else SERVER_JSON_PATH

# SDK repo root and UI build output
_SDK_PKG_DIR = Path(__file__).resolve().parent          # .../flow-cli/flow_sdk/
REPO_ROOT = _SDK_PKG_DIR.parent                          # .../flow-cli/
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
    GCP = "gcp"             # Google Cloud Secret Manager (production)


class StorageProvider(StrEnum):
    """Storage provider types for file system operations."""
    LOCAL = "local"
    S3 = "s3"
    AZURE = "azure"
    GCS = "gcs"
    SFTP = "sftp"
    SANDBOX = "sandbox"


class EmailProviderType(StrEnum):
    """Email provider types."""
    SENDGRID = "sendgrid"
    MOCK = "mock"


class ComputeProviderType(StrEnum):
    """Compute provider types."""
    LOCAL = "local"
    LOCAL_MACHINE = "local_machine"
    GCP = "gcp"
    AWS = "aws"
    E2B = "e2b"


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
        temp_dir = tempfile.gettempdir()
        # Create a flowpad directory in the temp directory
        FLOWPAD_TEMP_DIR = os.path.join(temp_dir, "flowpad_temp")
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
    data.update({
        "port": port,
        "webhook_path": "/api/v1/webhook/listen",
        "health_path": "/api/v1/health/status",
    })
    return save_server_info(data)


def set_server_info(data: dict) -> Path:
    """Merge-write data into the active server json (dev or prod). Atomic."""
    existing = load_server_info()
    existing.update(data)
    return save_server_info(existing)


def clear_server_info() -> None:
    """Remove sentinel keys (server_pid, monitor_pid, launch_iso_time) from active file."""
    try:
        info = load_server_info()
        info.pop("server_pid", None)
        info.pop("monitor_pid", None)
        info.pop("launch_iso_time", None)
        save_server_info(info)
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


# ---------------------------------------------------------------------------
# Service URL configuration
# ---------------------------------------------------------------------------

class ServiceUrlsConfig(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # Simple port configuration (loaded from environment)
    backend_scheme: str = "http"
    backend_host: str = "localhost"
    backend_port: int | None = None
    frontend_scheme: str = "http"
    frontend_host: str = "localhost"
    frontend_port: int | None = None
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
    no_reply_email: str = "no-reply@example.com"
    sendgrid_api_key: str | None = None
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
        # Get user data folder for desktop
        user_data_folder = get_user_desktop_data_folder()

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

        # Configure SQLite-specific paths only when using SQLite
        if self.db_driver == DBDriver.SQLITE.value:
            db_folder = Path.home() / ".flow" / "db"
            db_folder.mkdir(parents=True, exist_ok=True)
            sqlite_db_path = str(db_folder / "flowpad_db")
            # Only set the default path if not already configured — allows tests and
            # explicit env var overrides (e.g. SQLITE_DATABASE_PATH=/tmp/flowpad_test.db)
            # to take precedence over the production default.
            if ENV_SQLITE_DATABASE_PATH not in os.environ:
                os.environ[ENV_SQLITE_DATABASE_PATH] = sqlite_db_path
            else:
                sqlite_db_path = os.environ[ENV_SQLITE_DATABASE_PATH]
            db_info = f"SQLite at {sqlite_db_path}"
        else:
            db_info = f"{self.db_driver} database driver"

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
DEVELOPMENT = os.getenv("DEVELOPMENT", False)
