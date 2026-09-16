"""Per-instance default credential environment.

A process's credential environment is the ``environment`` of the Deployment it
runs under. A process with no Deployment — a plain terminal, a chat session,
a node command — uses this instance's default instead, and ``development``
(this computer) when none is set.

A cloud machine sets its default when it adopts its placement: a box hosts one
deployment, so its plain terminals should read that deployment's values.

Stored via ``app_config`` (``<instance_dir>/config.json``) like
``runtime_kind``: it names an environment, it is not a secret.
"""

from __future__ import annotations

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    is_valid_environment,
    normalize_environment,
)

_CONFIG_KEY = "default_environment"

# Keyed by instance NAME, as ``runtime.py`` explains: a process that switches
# FLOW_INSTANCE must not read another instance's value.
_cache: dict[str, str] = {}


def get_default_environment() -> str:
    """This instance's default credential environment (``development`` when unset)."""
    key = get_instance_settings().instance_name
    if key in _cache:
        return _cache[key]
    raw = str(app_config.get_config(_CONFIG_KEY) or "").strip()
    # An invalid value on disk (a newer build's spelling) reads as unset, not an error.
    value = raw if raw and is_valid_environment(raw) else DEFAULT_ENVIRONMENT
    _cache[key] = value
    return value


def set_default_environment(environment: str) -> str:
    """Persist this instance's default credential environment and return it."""
    value = normalize_environment(environment)
    app_config.set_config(_CONFIG_KEY, value)
    _cache[get_instance_settings().instance_name] = value
    return value


def reset_cache() -> None:
    """Drop the memo. For tests, which move instance dirs under the module's feet."""
    _cache.clear()
