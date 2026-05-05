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
from dataclasses import dataclass
from pathlib import Path


# Env var names — duplicated here on purpose to keep this a true leaf module.
ENV_LOCAL_SERVER_PORT = "LOCAL_SERVER_PORT"
ENV_DESKTOP_DB = "DESKTOP_DB"
ENV_SQLITE_DATABASE_PATH = "SQLITE_DATABASE_PATH"
ENV_FS_RECORD_PATH = "FS_RECORD_PATH"
ENV_FLOWPAD_CLAUDE_HOME = "FLOWPAD_CLAUDE_HOME"

DEFAULT_PROD_PORT = 9007
DEFAULT_DB_DRIVER = "sqlite"


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

    # ---- Defaults / runtime ----
    default_compute_provider: str = "local-machine"
    auth_provider: str = "custom"
    job_runner_type: str = "local"

    # ---- Cloud creds (env-mode auto-login). None when env vars unset. ----
    cloud_user_email: str | None = None
    cloud_user_pass: str | None = None

    # ---- Cloud login: max wait for browser-mode callback. Override via CLOUD_LOGIN_TIMEOUT_SECONDS. ----
    cloud_login_timeout_seconds: float = 300.0

    # ---- Process info (filled at boot, optional) ----
    server_pid: int | None = None

    # -----------------------------------------------------------------
    # Construction
    # -----------------------------------------------------------------

    @classmethod
    def from_env(cls) -> BaseInstanceSettings:
        """Build the prod-default instance from current env."""
        flow_home = cls._resolve_flow_home()
        claude_home = cls._resolve_claude_home()
        records_root = cls._resolve_records_root(flow_home, default_subdir="records")
        db_dir = cls._resolve_db_dir(flow_home, default_subdir="db")
        db_path = cls._resolve_db_path(db_dir)
        port = cls._resolve_port(default_port=DEFAULT_PROD_PORT)

        return cls(
            instance_name="prod",
            is_dev=False,
            port=port,
            server_json_path=flow_home / "server.json",
            server_pid_path=flow_home / "server.pid",
            server_lock_path=flow_home / "server.lock",
            server_log_path=flow_home / "server.log",
            flow_home=flow_home,
            records_root=records_root,
            db_dir=db_dir,
            db_path=db_path,
            tasks_dir=flow_home / "tasks",
            skill_rules_dir=flow_home / "skill_rules",
            schema_dir=flow_home / "schema",
            records_data_dir=flow_home / "records_data",
            logs_dir=flow_home / "logs",
            monitor_log_path=flow_home / "monitor.log",
            inbox_last_fetch_path=flow_home / ".inbox_last_fetch.json",
            conversation_last_sync_path=flow_home / ".conversation_last_sync.json",
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
        return Path.home() / ".flow"

    @staticmethod
    def _resolve_claude_home() -> Path:
        env = os.environ.get(ENV_FLOWPAD_CLAUDE_HOME)
        return Path(env) if env else Path.home() / ".claude"

    @staticmethod
    def _resolve_records_root(flow_home: Path, default_subdir: str) -> Path:
        env = os.environ.get(ENV_FS_RECORD_PATH)
        return Path(env) if env else flow_home / default_subdir

    @staticmethod
    def _resolve_db_dir(flow_home: Path, default_subdir: str) -> Path:
        return flow_home / default_subdir

    @staticmethod
    def _resolve_db_path(db_dir: Path) -> Path:
        env = os.environ.get(ENV_SQLITE_DATABASE_PATH)
        return Path(env) if env else db_dir / "flowpad_db"

    @staticmethod
    def _resolve_port(default_port: int) -> int:
        env = os.environ.get(ENV_LOCAL_SERVER_PORT)
        if env and env.isdigit():
            return int(env)
        return default_port


# Public alias — code reads ``InstanceSettings`` for type annotations.
InstanceSettings = BaseInstanceSettings
