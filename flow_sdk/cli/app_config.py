#!/usr/bin/env python3
"""Per-instance application configuration.

Phase D: config lives at ``<instance_dir>/config.json`` (per-instance JSON
file), replacing the legacy single ``~/Library/Application Support/flow-cli/
config.json`` that used per-instance suffixes (``user``, ``user:dev``,
``user:test``) as key namespaces.

The public API (``get_config`` / ``set_config`` / ``get_user`` / ``set_user`` /
``clear_user``) is unchanged — only the storage location moves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


USER_KEY = "user"


def _config_file_path() -> Path:
    """Resolve the per-instance config.json path. Lazy so import doesn't
    create the directory (or fail if instance_settings isn't loadable)."""
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().instance_dir / "config.json"


# Back-compat module attribute. Computed lazily on first access by callers
# that expected ``app_config.config_file_path`` at import time.
def __getattr__(name: str):
    if name == "config_file_path":
        return _config_file_path()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _load_config() -> dict:
    """Load the per-instance configuration. Returns {} if the file doesn't
    exist or is corrupt."""
    path = _config_file_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save_config(config: dict) -> None:
    """Atomic-ish write: ensure the instance_dir exists, then write the file.
    The instance_dir may not exist yet on a fresh install — create it."""
    path = _config_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2))


def set_config(key: str, value: Any) -> None:
    """Set a configuration value. Supports native Python types and
    JSON-serializable composites."""
    config = _load_config()
    config[key] = value
    _save_config(config)


def get_config(key: str, default: Any = None) -> Any:
    """Get a configuration value, or ``default`` if not set."""
    return _load_config().get(key, default)


def get_user() -> dict | None:
    """Return the stored user record for the current instance, or None."""
    return get_config(USER_KEY)


def set_user(user_info: dict) -> None:
    """Persist the user record for the current instance."""
    set_config(USER_KEY, user_info)


def clear_user() -> None:
    """Drop the user record for the current instance. Idempotent."""
    config = _load_config()
    if USER_KEY in config:
        del config[USER_KEY]
        _save_config(config)
