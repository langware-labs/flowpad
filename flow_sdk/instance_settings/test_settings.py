"""TestInstanceSettings — applied when FLOWPAD_TEST=true or PYTEST_CURRENT_TEST is set.

Every path lives under a sandbox dir, never ``~/.flow`` and never
``~/.claude``. This is the single mechanism that prevents tests from
polluting the dev/prod DB or writing fixture skills/agents into the user's
real ``~/.claude/skills/`` and ``~/.claude/agents/``.

Sandbox root precedence:
  1. ``FLOWPAD_TEST_SANDBOX`` env var, if set
  2. ``$TMPDIR/flowpad-test-<pid>``

The sandbox dir is mkdir'd on construction so callers get a guaranteed-empty
isolated environment. Pytest's per-process pid suffix means parallel test
processes get distinct sandboxes automatically.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .base_settings import (
    DEFAULT_DB_DRIVER,
    ENV_CODEX_HOME,
    ENV_DESKTOP_DB,
    ENV_FLOWPAD_CLAUDE_HOME,
    ENV_FS_RECORD_PATH,
    ENV_SQLITE_DATABASE_PATH,
    BaseInstanceSettings,
)

ENV_FLOWPAD_TEST_SANDBOX = "FLOWPAD_TEST_SANDBOX"
DEFAULT_TEST_PORT = 9009


class TestInstanceSettings(BaseInstanceSettings):
    """Test-mode settings. All paths anchored under a sandbox dir."""

    @classmethod
    def from_env(cls) -> "TestInstanceSettings":
        sandbox = cls._resolve_sandbox()
        sandbox.mkdir(parents=True, exist_ok=True)

        flow_home = sandbox / ".flow"
        # Honour ``FLOWPAD_CLAUDE_HOME`` so long-running tests that drive a
        # real ``claude`` CLI can point flow_sdk at the same ``~/.claude``
        # location the CLI itself writes to. Default stays sandboxed.
        claude_home_env = os.environ.get(ENV_FLOWPAD_CLAUDE_HOME)
        claude_home = Path(claude_home_env) if claude_home_env else sandbox / ".claude"
        codex_home_env = os.environ.get(ENV_CODEX_HOME)
        codex_home = Path(codex_home_env) if codex_home_env else sandbox / ".codex"
        flow_home.mkdir(parents=True, exist_ok=True)
        claude_home.mkdir(parents=True, exist_ok=True)
        codex_home.mkdir(parents=True, exist_ok=True)
        for sub in ("skills", "agents", "projects", "commands", "plans", "workflows", "docs", "tasks"):
            (claude_home / sub).mkdir(parents=True, exist_ok=True)
        (codex_home / "sessions").mkdir(parents=True, exist_ok=True)

        # Tests can still override via FS_RECORD_PATH / SQLITE_DATABASE_PATH for
        # per-test isolation on top of the sandbox.
        records_env = os.environ.get(ENV_FS_RECORD_PATH)
        records_root = Path(records_env) if records_env else flow_home / "records"

        db_dir = flow_home / "db"
        db_env = os.environ.get(ENV_SQLITE_DATABASE_PATH)
        db_path = Path(db_env) if db_env else db_dir / "flowpad_db"

        port = cls._resolve_port(default_port=DEFAULT_TEST_PORT)

        return cls(
            instance_name="test",
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
            logs_dir=flow_home / "instances" / "test" / "logs",
            monitor_log_path=flow_home / "monitor.log",
            inbox_last_fetch_path=flow_home / ".inbox_last_fetch.json",
            conversation_last_sync_path=flow_home / ".conversation_last_sync.json",
            toplog_config_path=flow_home / "toplog.json",
            db_driver=os.environ.get(ENV_DESKTOP_DB, DEFAULT_DB_DRIVER).lower(),
            user_home=sandbox,
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

    @staticmethod
    def _resolve_sandbox() -> Path:
        env = os.environ.get(ENV_FLOWPAD_TEST_SANDBOX)
        if env:
            return Path(env)
        return Path(tempfile.gettempdir()) / f"flowpad-test-{os.getpid()}"
