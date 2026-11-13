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
import os
import tempfile
from pathlib import Path
from typing import Any


USER_KEY = "user"
PRINCIPAL_KEY = "principal"


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
    """Atomic write: a sibling temp file, then ``os.replace``.

    Writing in place truncates first, and ``_load_config`` reads a half-written
    file as ``{}`` — so while ANY key was being saved, a concurrent ``get_user``
    saw no user and ``is_logged_in()`` answered False. ``handle_add_message``
    then treated a shared conversation as local and never sent the message to
    the hub (3.8% of reads under a write loop). The instance_dir may not exist
    yet on a fresh install — create it."""
    path = _config_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(config, indent=2))
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def set_config(key: str, value: Any) -> None:
    """Set a configuration value. Supports native Python types and
    JSON-serializable composites."""
    config = _load_config()
    config[key] = value
    _save_config(config)


def get_config(key: str, default: Any = None) -> Any:
    """Get a configuration value, or ``default`` if not set."""
    return _load_config().get(key, default)


def as_principal(record: Any) -> dict | None:
    """A stored login record as a principal: ``type`` is ``user`` or ``identity``. A record written before the
    principal existed was the hub's user-shaped projection, which marked an agent with ``is_identity``."""
    if not isinstance(record, dict) or not record.get("id"):
        return None
    if record.get("is_identity"):
        keep = ("id", "name", "title", "picture", "subject_typeid", "status")
        record = {**{k: record[k] for k in keep if k in record}, "type": "identity"}
    elif record.get("type") != "identity":
        record = {**record, "type": "user"}
    from flow_sdk.fs_store.type_id import type_id_str

    return {**record, "typeid": type_id_str(record["type"], str(record["id"]))}


def get_principal() -> dict | None:
    """Who this instance is signed in to the hub as: the ``/current-principal`` record, or None.
    ``type`` is ``user`` (a person) or ``identity`` (an agent or a deployment), ``typeid`` always set.

    The rule for callers: "is this me" (my message, my row, my credentials) asks the PRINCIPAL;
    what needs a person (an email, an invitation, a person's hub routes) asks :func:`get_user`."""
    config = _load_config()
    return as_principal(config.get(PRINCIPAL_KEY) or config.get(USER_KEY))


def get_user() -> dict | None:
    """The signed-in PERSON's record, or None -- also when the principal is an Identity, which is no person."""
    principal = get_principal()
    return principal if principal and principal.get("type") == "user" else None


def set_principal(principal: dict) -> None:
    """Persist who this instance is signed in as, normalized (``{}`` signs it out)."""
    normalized = as_principal(principal) if principal else None
    if principal and normalized is None:
        raise ValueError("a signed-in principal needs an id")
    config = _load_config()
    config.pop(USER_KEY, None)
    if normalized:
        config[PRINCIPAL_KEY] = normalized
    else:
        config.pop(PRINCIPAL_KEY, None)
    _save_config(config)


def is_switching_principal(incoming: Any) -> bool:
    """Whether signing in as ``incoming`` (a hub record) replaces a DIFFERENT principal signed in here."""
    current, new = get_principal(), as_principal(incoming)
    return bool(current and new and current["typeid"] != new["typeid"])


def set_user(user_info: dict) -> None:
    """Persist the signed-in record. Kept for callers that predate the principal: it IS the principal."""
    set_principal(user_info)


def clear_user() -> None:
    """Sign this instance out of the hub: drop the principal record. Idempotent."""
    set_principal({})
