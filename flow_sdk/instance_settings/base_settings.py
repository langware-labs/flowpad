"""BaseInstanceSettings — the prod-mode defaults.

Single source of truth for every per-instance path, name, and setting. Other
modes (dev, test) subclass this and override only what diverges.

Frozen dataclass: callers can't mutate at runtime. Construction goes through
``BaseInstanceSettings.from_env()`` which honors all standard override env
vars (LOCAL_SERVER_PORT, SQLITE_DATABASE_PATH, FS_RECORD_PATH,
FLOWPAD_CLAUDE_HOME, DESKTOP_DB).

Direct construction of ``Path.home() / ".flow" / X`` anywhere else in
``flow_sdk/`` is a violation of the single-source-of-truth contract — read
through ``get_instance_settings()`` instead.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.sod.file_sod import FileSodStorage


# Env var names — duplicated here on purpose to keep this a true leaf module.
ENV_LOCAL_SERVER_PORT = "LOCAL_SERVER_PORT"
ENV_FLOW_HOME = "FLOW_HOME"
ENV_DESKTOP_DB = "DESKTOP_DB"
ENV_SQLITE_DATABASE_PATH = "SQLITE_DATABASE_PATH"
ENV_FS_RECORD_PATH = "FS_RECORD_PATH"
ENV_FLOWPAD_CLAUDE_HOME = "FLOWPAD_CLAUDE_HOME"
ENV_CODEX_HOME = "CODEX_HOME"

DEFAULT_PROD_PORT = 9007
DEFAULT_DB_DRIVER = "sqlite"

# Phase B additions — instance identity + sod accessor.
INSTANCE_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
SOD_KEY_KEYCHAIN_SERVICE = "Flowpad.ai.sod_key"
CONSENT_MARKER_FILENAME = ".secrets_enabled"
SODOT_FILENAME = "sodot"

# Module-level cache for the per-instance Fernet key. Populated once per
# (process, instance_name) — the keychain prompt fires at most once.
_SOD_KEY_CACHE: dict[str, bytes] = {}


class SecretsNotEnabledError(RuntimeError):
    """Raised when ``instance.sod`` is accessed before ``enable_secrets()``.

    The consent gate is structural — any code path that reaches the sod
    accessor without prior consent fails loudly rather than silently
    triggering an OS keychain prompt.
    """


@dataclass(frozen=True)
class BaseInstanceSettings:
    """Resolved per-instance config. Defaults are prod values."""

    # ---- Identity ----
    instance_name: str           # "prod" | "dev" | "test"
    is_dev: bool

    # ---- Networking ----
    port: int
    server_json_path: Path
    server_pid_path: Path
    server_lock_path: Path
    server_log_path: Path

    # ---- Storage roots (per-instance) ----
    flow_home: Path
    records_root: Path
    db_dir: Path
    db_path: Path
    tasks_dir: Path
    skill_rules_dir: Path
    schema_dir: Path
    records_data_dir: Path

    # ---- Logs ----
    logs_dir: Path
    monitor_log_path: Path
    inbox_last_fetch_path: Path
    conversation_last_sync_path: Path

    # ---- Toplog filter file (watched by the builtin FSOp toplog trigger) ----
    toplog_config_path: Path

    # ---- Database ----
    db_driver: str               # "sqlite" | "neo4j" | "networkx"

    # ---- User-level (intentionally shared across instances unless overridden) ----
    user_home: Path
    claude_home: Path
    claude_skills_dir: Path
    claude_agents_dir: Path
    claude_projects_dir: Path
    claude_commands_dir: Path
    claude_plans_dir: Path
    claude_workflows_dir: Path
    claude_docs_dir: Path
    claude_tasks_dir: Path
    claude_history_path: Path
    claude_mcp_json_path: Path
    claude_settings_json_path: Path
    claude_managed_settings_path: Path

    # Codex (~/.codex). User-level — shared across instances unless overridden.
    codex_home: Path
    codex_sessions_dir: Path
    codex_config_path: Path
    codex_history_path: Path
    codex_session_index_path: Path

    # ---- Defaults / runtime ----
    default_compute_provider: str = "local-machine"
    auth_provider: str = "custom"
    job_runner_type: str = "local"

    # ---- Cloud creds (env-mode auto-login). None when env vars unset. ----
    cloud_user_email: str | None = None
    cloud_user_pass: str | None = None

    # ---- Cloud login: max wait for browser-mode callback. Override via CLOUD_LOGIN_TIMEOUT_SECONDS. ----
    cloud_login_timeout_seconds: float = 300.0

    # ---- Sniffer: single source of truth for whether the desktop bootstrap
    # auto-installs the Claude-Code hooks into ~/.claude/settings.json.
    # Default off; flip to true to opt in. Frontend reads the resulting
    # bootstrap.sniffer_hook payload (null when disabled). ----
    sniffer_enabled: bool = False

    # ---- Process info (filled at boot, optional) ----
    server_pid: int | None = None

    # -----------------------------------------------------------------
    # Construction
    # -----------------------------------------------------------------

    @classmethod
    def from_env(cls, name: str = "prod") -> BaseInstanceSettings:
        """Build a base instance with the given name (default ``"prod"``).

        ``name`` flows through from the resolver in ``__init__.get_instance_settings``,
        so arbitrary instance names (e.g. ``"oss"``, ``"app"``, ``"stage"``) get
        their own per-instance directory rather than falling back to ``prod``.
        """
        return cls._build_from_env(
            cls=cls,
            instance_name=name,
            is_dev=False,
            default_port=DEFAULT_PROD_PORT,
        )

    @staticmethod
    def _build_from_env(
        *, cls: type, instance_name: str, is_dev: bool, default_port: int,
    ) -> "BaseInstanceSettings":
        """Shared from_env body — Phase F consolidation.

        Replaces the per-subclass duplication of ~50 lines of dataclass
        construction with a single implementation that varies only by
        ``instance_name``, ``is_dev``, and ``default_port``. Subclasses
        (DevInstanceSettings / TestInstanceSettings) call this and pass
        their own constants.
        """
        flow_home = cls._resolve_flow_home()
        claude_home = cls._resolve_claude_home()
        codex_home = cls._resolve_codex_home()
        instance_dir = flow_home / "instances" / instance_name
        records_root = cls._resolve_records_root_in(instance_dir)
        db_path = cls._resolve_db_path_in(instance_dir)
        port = cls._resolve_port(default_port=default_port)

        return cls(
            instance_name=instance_name,
            is_dev=is_dev,
            port=port,
            server_json_path=instance_dir / "server.json",
            server_pid_path=instance_dir / "server.pid",
            server_lock_path=instance_dir / "server.lock",
            # server_log_path is dead — launch.py writes timestamped files
            # under logs_dir/server/<ts>.log. Kept as a placeholder so the
            # field still exists for back-compat readers.
            server_log_path=instance_dir / "logs" / "server.log",
            flow_home=flow_home,
            records_root=records_root,
            # db_dir intentionally equals instance_dir under the new layout —
            # the sqlite file lives directly at instance_dir/flowpad.db, not
            # under a separate db/ subdir.
            db_dir=instance_dir,
            db_path=db_path,
            tasks_dir=instance_dir / "tasks",
            skill_rules_dir=instance_dir / "skill_rules",
            schema_dir=instance_dir / "schema",
            records_data_dir=instance_dir / "records_data",
            logs_dir=instance_dir / "logs",
            # monitor_log_path is also dead (see Phase B audit note); kept
            # as a placeholder under the canonical logs dir.
            monitor_log_path=instance_dir / "logs" / "monitor.log",
            inbox_last_fetch_path=instance_dir / "inbox.json",
            conversation_last_sync_path=instance_dir / "conversation_sync.json",
            toplog_config_path=instance_dir / "toplog.json",
            db_driver=os.environ.get(ENV_DESKTOP_DB, DEFAULT_DB_DRIVER).lower(),
            user_home=Path.home(),
            claude_home=claude_home,
            claude_skills_dir=claude_home / "skills",
            claude_agents_dir=claude_home / "agents",
            claude_projects_dir=claude_home / "projects",
            claude_commands_dir=claude_home / "commands",
            claude_plans_dir=claude_home / "plans",
            claude_workflows_dir=claude_home / "workflows",
            claude_docs_dir=claude_home / "docs",
            claude_tasks_dir=claude_home / "tasks",
            claude_history_path=claude_home / "history.jsonl",
            claude_mcp_json_path=claude_home / "mcp.json",
            claude_settings_json_path=claude_home / "settings.json",
            claude_managed_settings_path=claude_home / "managed-settings.json",
            codex_home=codex_home,
            codex_sessions_dir=codex_home / "sessions",
            codex_config_path=codex_home / "config.toml",
            codex_history_path=codex_home / "history.jsonl",
            codex_session_index_path=codex_home / "session_index.jsonl",
            cloud_user_email=os.environ.get("FLOWPAD_CLOUD_USER_EMAIL") or None,
            cloud_user_pass=os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD") or None,
            cloud_login_timeout_seconds=cls._resolve_login_timeout(),
        )

    # -----------------------------------------------------------------
    # Resolver helpers — subclasses can call into these
    # -----------------------------------------------------------------

    @staticmethod
    def _resolve_login_timeout() -> float:
        raw = os.environ.get("CLOUD_LOGIN_TIMEOUT_SECONDS")
        if not raw:
            return 300.0
        try:
            return max(1.0, float(raw))
        except ValueError:
            return 300.0

    @staticmethod
    def _resolve_flow_home() -> Path:
        env = os.environ.get(ENV_FLOW_HOME)
        return Path(env) if env else Path.home() / ".flow"

    @staticmethod
    def _resolve_claude_home() -> Path:
        env = os.environ.get(ENV_FLOWPAD_CLAUDE_HOME)
        return Path(env) if env else Path.home() / ".claude"

    @staticmethod
    def _resolve_codex_home() -> Path:
        env = os.environ.get(ENV_CODEX_HOME)
        return Path(env) if env else Path.home() / ".codex"

    @staticmethod
    def _resolve_records_root(flow_home: Path, default_subdir: str) -> Path:
        """Legacy resolver: ``<flow_home>/<default_subdir>``. Kept for any
        external caller that still references it. New code uses
        ``_resolve_records_root_in(instance_dir)``."""
        env = os.environ.get(ENV_FS_RECORD_PATH)
        return Path(env) if env else flow_home / default_subdir

    @staticmethod
    def _resolve_records_root_in(instance_dir: Path) -> Path:
        """``<instance_dir>/records`` with FS_RECORD_PATH override."""
        env = os.environ.get(ENV_FS_RECORD_PATH)
        return Path(env) if env else instance_dir / "records"

    @staticmethod
    def _resolve_db_dir(flow_home: Path, default_subdir: str) -> Path:
        """Legacy resolver — kept for back-compat. New code uses
        ``instance_dir`` directly as the db parent."""
        return flow_home / default_subdir

    @staticmethod
    def _resolve_db_path(db_dir: Path) -> Path:
        """Legacy resolver: ``<db_dir>/flowpad_db``. Kept for back-compat.
        New code uses ``_resolve_db_path_in(instance_dir)``."""
        env = os.environ.get(ENV_SQLITE_DATABASE_PATH)
        return Path(env) if env else db_dir / "flowpad_db"

    @staticmethod
    def _resolve_db_path_in(instance_dir: Path) -> Path:
        """``<instance_dir>/flowpad.db`` with SQLITE_DATABASE_PATH override.

        Note the filename change: legacy ``flowpad_db`` (no extension)
        becomes ``flowpad.db`` to match the migration script's flattening of
        ``db/flowpad_db`` → ``flowpad.db``.
        """
        env = os.environ.get(ENV_SQLITE_DATABASE_PATH)
        return Path(env) if env else instance_dir / "flowpad.db"

    @staticmethod
    def _resolve_port(default_port: int) -> int:
        env = os.environ.get(ENV_LOCAL_SERVER_PORT)
        if env and env.isdigit():
            return int(env)
        return default_port

    # -----------------------------------------------------------------
    # Cross-instance shared paths (computed; not per-instance prefixed)
    # -----------------------------------------------------------------
    # These live directly under ``flow_home`` and are shared across all
    # instances (prod/dev/test) by design — they coordinate state that
    # spans instances, like the migration ledger.

    @property
    def global_dir(self) -> Path:
        """``<flow_home>/global`` — cross-instance shared state."""
        return self.flow_home / "global"

    @property
    def migrations_status_dir(self) -> Path:
        """``<flow_home>/global/migrations`` — per-version status JSON files."""
        return self.global_dir / "migrations"

    @property
    def instances_root(self) -> Path:
        """``<flow_home>/instances`` — parent of per-instance canonical
        subdirectories. Contents under each ``instances/<name>/`` are
        out of scope for Phase 1; this exposes the parent path only."""
        return self.flow_home / "instances"

    # -----------------------------------------------------------------
    # Phase B: per-instance canonical directory + sod accessor.
    # Existing path properties (server_json_path, db_path, ...) still
    # point at the legacy locations under flow_home for back-compat;
    # Phase D moves them under instance_dir.
    # -----------------------------------------------------------------

    @property
    def instance_dir(self) -> Path:
        """``<flow_home>/instances/<instance_name>`` — per-instance canonical root."""
        return self.instances_root / self.instance_name

    @property
    def sodot_path(self) -> Path:
        """Encrypted secrets file under ``instance_dir``."""
        return self.instance_dir / SODOT_FILENAME

    @property
    def consent_marker_path(self) -> Path:
        """Consent marker file. Presence ⇔ user has approved keychain access.

        Separate from ``sodot_path`` so "consent given" and "sodot has
        content" remain independent facts. Touched by ``enable_secrets()``.
        """
        return self.instance_dir / CONSENT_MARKER_FILENAME

    @property
    def sod(self) -> "FileSodStorage":
        """Per-instance encrypted-secrets accessor.

        Raises :class:`SecretsNotEnabledError` if ``enable_secrets()`` has
        not yet been called for this instance. This is the single
        structural guard that prevents accidental keychain prompts from
        upstream code paths.
        """
        if not self.consent_marker_path.exists():
            raise SecretsNotEnabledError(
                f"Secrets not enabled for instance {self.instance_name!r}. "
                f"Call enable_secrets() first."
            )
        from flow_sdk.sod.file_sod import FileSodStorage
        key = _fetch_or_create_sod_key(self.instance_name)
        return FileSodStorage(key=key, file_path=self.sodot_path)


def _fetch_or_create_sod_key(instance_name: str) -> bytes:
    """Return the Fernet key for ``instance_name`` from the OS keychain.

    Generates a new key on first use and stores it under
    ``Flowpad.ai.sod_key`` / ``<instance_name>``. This is the ONLY function
    permitted to trigger a fresh OS keychain prompt — and it should only
    be called from ``enable_secrets()`` or, after consent, from the
    ``InstanceSettings.sod`` accessor (which itself gates on the consent
    marker, so the first call has always been preceded by the
    enable_secrets-triggered prompt).

    Cached per-process: the keychain is hit at most once per instance per
    process, even across many ``instance.sod`` accesses.
    """
    if instance_name in _SOD_KEY_CACHE:
        return _SOD_KEY_CACHE[instance_name]

    import keyring
    from cryptography.fernet import Fernet

    stored = keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name)
    if stored:
        key_bytes = stored.encode() if isinstance(stored, str) else stored
    else:
        key_bytes = Fernet.generate_key()
        keyring.set_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name, key_bytes.decode())
    _SOD_KEY_CACHE[instance_name] = key_bytes
    return key_bytes


def _reset_sod_key_cache() -> None:
    """Test helper. Drops the cached Fernet keys so the next ``instance.sod``
    access re-reads from the keychain. Production code must not call this.
    """
    _SOD_KEY_CACHE.clear()


# Public alias — code reads ``InstanceSettings`` for type annotations.
InstanceSettings = BaseInstanceSettings
