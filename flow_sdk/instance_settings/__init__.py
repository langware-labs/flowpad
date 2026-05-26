"""flow_sdk.instance_settings — single source of truth for per-instance config.

Public API:
    get_instance_settings()    -> InstanceSettings
    reset_instance_settings()  -> None
    InstanceSettings            (alias for BaseInstanceSettings, used in annotations)
    SecretsNotEnabledError      (raised by ``instance.sod`` before consent)

Resolution (test wins over dev wins over prod):
    test  ← FLOWPAD_TEST=true OR PYTEST_CURRENT_TEST in env
    dev   ← FLOWPAD_DEV=true
    prod  ← otherwise

Phase B: the cached singleton is now content-addressed by the resolved
``(instance_name, flow_home)`` pair. A process that legitimately switches
``FLOW_INSTANCE``/``FLOWPAD_DEV``/``FLOW_HOME`` mid-run gets the right
InstanceSettings on each call instead of the stale import-time freeze that
caused the cross-instance-leakage bug this refactor is fixing.

Direct path construction (e.g. ``Path.home() / ".flow" / X``) anywhere else in
``flow_sdk/`` is a contract violation — always go through this module.
"""

from __future__ import annotations

import os
import warnings
from pathlib import Path

from .base_settings import (
    BaseInstanceSettings,
    InstanceSettings,
    SecretsNotEnabledError,
    _reset_sod_key_cache,
)
from .dev_settings import DevInstanceSettings
from .test_settings import TestInstanceSettings


ENV_FLOW_INSTANCE = "FLOW_INSTANCE"
ENV_FLOWPAD_DEV = "FLOWPAD_DEV"
ENV_FLOWPAD_TEST = "FLOWPAD_TEST"
ENV_PYTEST_CURRENT_TEST = "PYTEST_CURRENT_TEST"
ENV_FLOW_HOME = "FLOW_HOME"


# Content-addressed cache: keyed by (resolved instance_name, resolved flow_home).
# A test or shell that changes FLOW_INSTANCE/FLOW_HOME and re-calls
# get_instance_settings() gets the matching instance back rather than the
# stale one — fixes the cross-instance state-leakage bug.
_INSTANCES: dict[tuple[str, Path], BaseInstanceSettings] = {}

# Per-process set of alias names we've already warned about — keep
# deprecation warnings to one-per-alias to avoid log spam in test suites
# that re-resolve on every call.
_WARNED_ALIASES: set[str] = set()


def get_instance_settings() -> BaseInstanceSettings:
    """Return the cached singleton for the current env.

    Re-reads env on each call (cheap), looks up by ``(name, flow_home)``,
    constructs on cache miss.
    """
    name = _resolve_instance_name_from_env()
    flow_home = _resolve_flow_home_from_env()
    key = (name, flow_home)
    cached = _INSTANCES.get(key)
    if cached is not None:
        return cached

    if name == "test":
        instance = TestInstanceSettings.from_env()
    elif name == "dev":
        instance = DevInstanceSettings.from_env()
    else:
        instance = BaseInstanceSettings.from_env(name=name)
    _INSTANCES[key] = instance
    return instance


def reset_instance_settings() -> None:
    """Drop the cache. Tests call this after monkeypatching env."""
    _INSTANCES.clear()
    _WARNED_ALIASES.clear()
    _reset_sod_key_cache()


# Alias used by base_settings.py docstring + new test fixtures.
_reset_for_tests = reset_instance_settings


def override_db_path(new_path: "Path | str") -> None:
    """Hot-swap the cached InstanceSettings' ``db_path`` to ``new_path``.

    Used by ``reinit_db`` for the UI's "DB Settings" → switch-database flow.
    Mutates the cached frozen dataclass via ``dataclasses.replace`` and
    re-caches under the same ``(name, flow_home)`` key, so subsequent
    ``get_instance_settings().db_path`` reads see the new path.

    **No env writes** — env is an input, never a channel. Writing
    ``SQLITE_DATABASE_PATH`` to ``os.environ`` was the live-incident
    poison channel (config.py validator) and the same pattern at the
    ``reinit_db`` call site permanently poisoned the process env for the
    rest of its lifetime.

    **Drops the cached SQLite driver** so the next ``get_db_driver()``
    rebuilds against the new path. Without this, the previously-cached
    driver keeps serving its snapshotted path and the override is a no-op
    for DB access. The driver-clear is scoped to the sqlite key only;
    other driver kinds (neo4j, networkx) are not affected and the broader
    instance-cache reset is left alone — ``reset_instance_settings`` is
    still the only path that wipes the singleton cache.
    """
    from dataclasses import replace as _replace  # noqa: PLC0415

    name = _resolve_instance_name_from_env()
    flow_home = _resolve_flow_home_from_env()
    key = (name, flow_home)
    current = _INSTANCES.get(key) or get_instance_settings()
    _INSTANCES[key] = _replace(current, db_path=Path(new_path))
    # Lazy import — db_driver imports back into instance_settings via
    # the SQLite connection helpers. Swallow ImportError so override is
    # usable from very-early code paths that haven't pulled in db yet.
    try:
        from flow_sdk.db.drivers.db_driver import _driver_instances  # noqa: PLC0415
        _driver_instances.pop("sqlite", None)
    except ImportError:
        pass


def override_records_root(new_path: "Path | str") -> None:
    """Hot-swap the cached InstanceSettings' ``records_root`` to ``new_path``.

    Test-helper companion to ``override_db_path``: same contract, same
    no-env-write discipline. Used by ``flow_sdk.fs_store.record.
    set_default_records_root`` (called by 40+ test fixtures) so the
    helper redirects the singleton without poisoning ``FS_RECORD_PATH``.
    """
    from dataclasses import replace as _replace  # noqa: PLC0415

    name = _resolve_instance_name_from_env()
    flow_home = _resolve_flow_home_from_env()
    key = (name, flow_home)
    current = _INSTANCES.get(key) or get_instance_settings()
    _INSTANCES[key] = _replace(current, records_root=Path(new_path))


def _resolve_instance_name_from_env() -> str:
    """Pick the active instance name.

    Order of precedence:
        1. FLOW_INSTANCE (the new canonical env var)
        2. FLOWPAD_TEST=true OR PYTEST_CURRENT_TEST → "test"
        3. FLOWPAD_DEV=true → "dev"
        4. default "prod"

    Back-compat aliases (2 + 3) emit a one-time DeprecationWarning per
    process so existing scripts keep working but the migration to
    FLOW_INSTANCE is surfaced.
    """
    explicit = os.environ.get(ENV_FLOW_INSTANCE)
    if explicit:
        return explicit
    if (os.environ.get(ENV_FLOWPAD_TEST, "").lower() == "true"
            or ENV_PYTEST_CURRENT_TEST in os.environ):
        _warn_once_deprecated_alias("test")
        return "test"
    if os.environ.get(ENV_FLOWPAD_DEV, "").lower() == "true":
        _warn_once_deprecated_alias("dev")
        return "dev"
    return "prod"


def _resolve_flow_home_from_env() -> Path:
    return BaseInstanceSettings._resolve_flow_home()


def _warn_once_deprecated_alias(name: str) -> None:
    if name in _WARNED_ALIASES:
        return
    _WARNED_ALIASES.add(name)
    warnings.warn(
        f"Resolving instance {name!r} via legacy alias "
        f"(FLOWPAD_DEV/FLOWPAD_TEST/PYTEST_CURRENT_TEST); "
        f"prefer FLOW_INSTANCE={name}.",
        DeprecationWarning,
        stacklevel=3,
    )


# Legacy mode-check helpers — kept for any external callers that import them.
def _is_test_mode() -> bool:
    return _resolve_instance_name_from_env() == "test"


def _is_dev_mode() -> bool:
    return _resolve_instance_name_from_env() == "dev"


__all__ = [
    "InstanceSettings",
    "BaseInstanceSettings",
    "DevInstanceSettings",
    "TestInstanceSettings",
    "SecretsNotEnabledError",
    "get_instance_settings",
    "reset_instance_settings",
    "override_db_path",
    "override_records_root",
]
