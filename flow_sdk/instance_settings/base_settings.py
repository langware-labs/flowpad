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
ENV_FLOWPAD_HUB_URL = "FLOWPAD_HUB_URL"
ENV_MINIHUB_HOST = "MINIHUB_HOST"
ENV_MINIHUB_RELOAD = "MINIHUB_RELOAD"
ENV_VITE_PORT = "VITE_PORT"
ENV_FLOWPAD_CLOUD_API_KEY = "FLOWPAD_CLOUD_API_KEY"
ENV_FLOWPAD_CLOUD_API_URL = "FLOWPAD_CLOUD_API_URL"
ENV_FLOWPAD_DOCKER_PUBLIC_URL = "FLOWPAD_DOCKER_PUBLIC_URL"
ENV_FLOWPAD_DESKTOP = "FLOWPAD_DESKTOP"
# Pass-through SOD Fernet key (e.g. supplied by Electron after it read the
# keychain) — when set, the per-instance sodot uses it directly and never
# touches the OS keychain. Same var that binds ServiceConfig.sod_enc_key.
ENV_SOD_ENC_KEY = "SOD_ENC_KEY"

DEFAULT_PROD_PORT = 9007
DEFAULT_DB_DRIVER = "sqlite"
DEFAULT_MINIHUB_HOST = "0.0.0.0"

# Phase B additions — instance identity + sod accessor.
INSTANCE_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
SOD_KEY_KEYCHAIN_SERVICE = "Flowpad.ai.sod_key"
CONSENT_MARKER_FILENAME = ".secrets_enabled"
SODOT_FILENAME = "sodot"

# Sentinel for the per-instance memoized key/store fields, set on the frozen
# dataclass via ``object.__setattr__`` (see ``sod_key`` / ``sod``). _UNSET means
# "not resolved yet". The memo lives on the (cached) InstanceSettings object, so
# there is no separate module-level key cache — the keychain prompt fires at
# most once per process, the first time a real secret is read or written.
_UNSET = object()


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
    transcript_cursors_path: Path

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

    # ---- Hub & cloud endpoints (env-driven; None when unset). ----
    hub_url: str | None = None
    cloud_api_key: str | None = None
    cloud_api_url: str | None = None
    docker_public_url: str | None = None

    # ---- Dev-server binding / reload — read once from MINIHUB_*/VITE_* env. ----
    host: str = DEFAULT_MINIHUB_HOST
    reload_enabled: bool = False
    vite_port: int | None = None

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
            transcript_cursors_path=instance_dir / "transcript_cursors.json",
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
            hub_url=os.environ.get(ENV_FLOWPAD_HUB_URL) or None,
            cloud_api_key=os.environ.get(ENV_FLOWPAD_CLOUD_API_KEY) or None,
            cloud_api_url=os.environ.get(ENV_FLOWPAD_CLOUD_API_URL) or None,
            docker_public_url=(os.environ.get(ENV_FLOWPAD_DOCKER_PUBLIC_URL) or "").strip() or None,
            host=cls._resolve_host(),
            reload_enabled=os.environ.get(ENV_MINIHUB_RELOAD, "").lower() == "true",
            vite_port=cls._resolve_vite_port(),
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

    @staticmethod
    def _resolve_vite_port() -> int | None:
        env = os.environ.get(ENV_VITE_PORT)
        if env and env.isdigit():
            return int(env)
        return None

    @staticmethod
    def _resolve_host() -> str:
        """Return MINIHUB_HOST exactly as the user set it, or the default.

        Uses an explicit ``is None`` check so an intentional
        ``MINIHUB_HOST=""`` (e.g. to defer to uvicorn's default binding
        behavior) is preserved rather than silently coerced to
        ``DEFAULT_MINIHUB_HOST`` by a truthy-or check.
        """
        env = os.environ.get(ENV_MINIHUB_HOST)
        return env if env is not None else DEFAULT_MINIHUB_HOST

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
    def sod_key(self) -> bytes:
        """Resolve (once, memoized) the per-instance Fernet key.

        Resolution order:
          1. ``SOD_ENC_KEY`` env — a pass-through key (e.g. forwarded by
             Electron after it unlocked the keychain). Used verbatim; the
             keychain AND the consent marker are bypassed (env ⇒ consent).
          2. The OS keychain (``_fetch_or_create_sod_key``), auto-minting on
             first use. We also ensure the ``.secrets_enabled`` marker exists
             so the non-prompting ``is_secrets_enabled()`` sentinel reflects
             reality — decoupled from cloud login: any first secret use sets
             it up, not just login.

        Memoized on this (frozen, process-cached) instance via
        ``object.__setattr__`` — so the keychain prompt fires at most once per
        process. ``dataclasses.replace`` drops this memo (not a dataclass
        field); that's fine, the next access lazily re-resolves.
        """
        cached = getattr(self, "_sod_key_memo", _UNSET)
        if cached is not _UNSET:
            return cached

        env_key = os.environ.get(ENV_SOD_ENC_KEY)
        if env_key:
            key_bytes = env_key.encode()
        else:
            key_bytes = _fetch_or_create_sod_key(self.instance_name)

        # Decoupled-from-login sentinel: record that this instance's local
        # secret store is set up, without ever gating availability on it.
        # Runs in both the env-key and keychain-mint paths so the marker is
        # consistent regardless of how the key was sourced.
        try:
            self.instance_dir.mkdir(parents=True, exist_ok=True)
            if not self.consent_marker_path.exists():
                self.consent_marker_path.touch(mode=0o600)
        except OSError:
            pass

        object.__setattr__(self, "_sod_key_memo", key_bytes)
        return key_bytes

    @property
    def sod(self) -> "FileSodStorage":
        """Per-instance encrypted-secrets store — ALWAYS available.

        The Fernet key is resolved lazily (see ``sod_key``) on the first real
        encrypt/decrypt, so merely obtaining the store — or reading a store
        whose file does not exist yet — never touches the keychain. There is
        no consent gate: the store works regardless of cloud-login state.
        Memoized so every caller shares one ``FileSodStorage`` instance.
        """
        cached = getattr(self, "_sod_store_memo", _UNSET)
        if cached is not _UNSET:
            return cached
        from flow_sdk.sod.file_sod import FileSodStorage
        store = FileSodStorage(key_provider=lambda: self.sod_key, file_path=self.sodot_path)
        object.__setattr__(self, "_sod_store_memo", store)
        return store


def _fetch_or_create_sod_key(instance_name: str) -> bytes:
    """Return the per-instance Fernet key from the OS keychain, minting a new
    random key on first use under ``Flowpad.ai.sod_key``.

    macOS / Windows (pip-installed): routes through the vendored, separately
    signed ``flow-rs`` binary at the ``<instance>.flow-rs`` slot — the SAME
    ``(service, account)`` the signed Electron launcher uses
    (``electron/flow-rs-keychain.js`` ``sodKeyAccount()``). Going through the
    signed binary binds the entry's ACL trust list to ``flow-rs`` (Langware
    Developer ID / Authenticode) instead of the unsigned ``python3.x`` a direct
    ``keyring`` call would bind, so later reads are prompt-free and the entry is
    interchangeable with the desktop app's. A one-time migration adopts any
    pre-existing python-``keyring``-owned key at the legacy bare ``<instance>``
    slot into the signed slot (re-writing the SAME value) so an existing
    ``sodot`` stays decryptable.

    Linux, or when no signed binary is vendored / it is disabled, falls back to
    the direct ``keyring`` path at the legacy bare slot (unchanged behavior).

    This is the keychain-touching primitive (it can trigger the OS prompt).
    Callers memoize the result on the InstanceSettings instance (see
    ``sod_key``), so it runs at most once per process.
    """
    if os.environ.get(ENV_FLOWPAD_DESKTOP) == "1":
        raise SecretsNotEnabledError(
            "Desktop backend refused Python keychain access for SOD key; "
            "Electron must provide SOD_ENC_KEY or seed the key via signed flow-rs."
        )

    from cryptography.fernet import Fernet

    from flow_sdk.flow_rs_binary import (
        FLOW_RS_ACCOUNT_SUFFIX,
        flow_rs_get_restricted,
        flow_rs_set_restricted,
        vendored_flow_rs_enabled,
    )

    # -- Signed-binary path (macOS / Windows with a vendored flow-rs) --
    if vendored_flow_rs_enabled():
        account = f"{instance_name}{FLOW_RS_ACCOUNT_SUFFIX}"

        existing = flow_rs_get_restricted(SOD_KEY_KEYCHAIN_SERVICE, account)
        if existing:
            return existing.encode()

        # One-time migration: adopt an existing python-keyring-owned key at the
        # legacy bare <instance> slot into the signed slot, preserving the value
        # so the existing sodot stays decryptable. Reading python's OWN prior
        # entry is ACL-silent on macOS.
        legacy = _read_legacy_keyring_key(instance_name)
        if legacy:
            flow_rs_set_restricted(SOD_KEY_KEYCHAIN_SERVICE, account, legacy)
            return legacy.encode()

        key_bytes = Fernet.generate_key()
        flow_rs_set_restricted(SOD_KEY_KEYCHAIN_SERVICE, account, key_bytes.decode())
        return key_bytes

    # -- Fallback: direct keyring at the legacy bare slot (Linux / disabled) --
    import keyring

    stored = keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name)
    if stored:
        return stored.encode() if isinstance(stored, str) else stored
    key_bytes = Fernet.generate_key()
    keyring.set_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name, key_bytes.decode())
    return key_bytes


def _read_legacy_keyring_key(instance_name: str) -> str | None:
    """Best-effort read of a pre-existing python-``keyring``-owned Fernet key at
    the legacy bare ``<instance>`` slot. Returns ``None`` if absent or keyring is
    unavailable. Kept local to avoid a circular import with the secrets layer."""
    try:
        import keyring
        return keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name)
    except Exception:  # noqa: BLE001
        return None


def _reset_sod_key_cache() -> None:
    """Back-compat no-op. The Fernet key is now memoized per-instance (see
    ``sod_key``); ``reset_instance_settings`` drops the instance cache, which
    drops the memo with it. Kept so existing callers/tests don't break.
    """
    return None


# Public alias — code reads ``InstanceSettings`` for type annotations.
InstanceSettings = BaseInstanceSettings
