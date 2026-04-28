"""DevInstanceSettings — applied when FLOWPAD_DEV=true.

Every per-instance path under ``~/.flow`` is prefixed with ``dev_`` so a
dev backend running on port 9008 is fully isolated from a prod backend
on port 9007. Both can run simultaneously without sharing DB / records /
logs / sessions / tasks / index state.

User-level paths under ``~/.claude`` are NOT prefixed — they're shared
between dev and prod by design (your real skills + agents are the same
identity regardless of which instance is running).
"""

from __future__ import annotations

from .base_settings import (
    DEFAULT_DB_DRIVER,
    ENV_DESKTOP_DB,
    BaseInstanceSettings,
)

import os

DEFAULT_DEV_PORT = 9008


class DevInstanceSettings(BaseInstanceSettings):
    """Dev-mode settings. All per-instance paths get a ``dev_`` prefix."""

    @classmethod
    def from_env(cls) -> "DevInstanceSettings":
        flow_home = cls._resolve_flow_home()
        claude_home = cls._resolve_claude_home()
        records_root = cls._resolve_records_root(flow_home, default_subdir="dev_records")
        db_dir = cls._resolve_db_dir(flow_home, default_subdir="dev_db")
        db_path = cls._resolve_db_path(db_dir)
        port = cls._resolve_port(default_port=DEFAULT_DEV_PORT)

        return cls(
            instance_name="dev",
            is_dev=True,
            port=port,
            server_json_path=flow_home / "dev_server.json",
            server_pid_path=flow_home / "dev_server.pid",
            server_lock_path=flow_home / "dev_server.lock",
            server_log_path=flow_home / "dev_server.log",
            flow_home=flow_home,
            records_root=records_root,
            db_dir=db_dir,
            db_path=db_path,
            indexer_state_dir=flow_home / "dev_indexer_state",
            index_dir=flow_home / "dev_index",
            sessions_dir=flow_home / "dev_sessions",
            tasks_dir=flow_home / "dev_tasks",
            storage_dir=flow_home / "dev_storage",
            skill_rules_dir=flow_home / "dev_skill_rules",
            schema_dir=flow_home / "dev_schema",
            records_data_dir=flow_home / "dev_records_data",
            logs_dir=flow_home / "dev_logs",
            monitor_log_path=flow_home / "dev_monitor.log",
            inbox_last_fetch_path=flow_home / ".dev_inbox_last_fetch.json",
            db_driver=os.environ.get(ENV_DESKTOP_DB, DEFAULT_DB_DRIVER).lower(),
            claude_home=claude_home,
            claude_skills_dir=claude_home / "skills",
            claude_agents_dir=claude_home / "agents",
            claude_projects_dir=claude_home / "projects",
        )
