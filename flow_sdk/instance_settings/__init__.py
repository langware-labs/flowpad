"""flow_sdk.instance_settings — single source of truth for per-instance config.

Public API:
    get_instance_settings()    -> InstanceSettings
    reset_instance_settings()  -> None
    InstanceSettings            (alias for BaseInstanceSettings, used in annotations)

Resolution (test wins over dev wins over prod):
    test  ← FLOWPAD_TEST=true OR PYTEST_CURRENT_TEST in env
    dev   ← FLOWPAD_DEV=true
    prod  ← otherwise

Direct path construction (e.g. ``Path.home() / ".flow" / X``) anywhere else in
``flow_sdk/`` is a contract violation — always go through this module.
"""

from __future__ import annotations

import os

from .base_settings import BaseInstanceSettings, InstanceSettings
from .dev_settings import DevInstanceSettings
from .test_settings import TestInstanceSettings


ENV_FLOWPAD_DEV = "FLOWPAD_DEV"
ENV_FLOWPAD_TEST = "FLOWPAD_TEST"
ENV_PYTEST_CURRENT_TEST = "PYTEST_CURRENT_TEST"


_cached: BaseInstanceSettings | None = None


def get_instance_settings() -> BaseInstanceSettings:
    """Return the cached singleton. Builds on first call, picks the subclass."""
    global _cached
    if _cached is None:
        _cached = _resolve_from_env()
    return _cached


def reset_instance_settings() -> None:
    """Drop the cache. Tests call this after monkeypatching env."""
    global _cached
    _cached = None


def _resolve_from_env() -> BaseInstanceSettings:
    if _is_test_mode():
        return TestInstanceSettings.from_env()
    if _is_dev_mode():
        return DevInstanceSettings.from_env()
    return BaseInstanceSettings.from_env()


def _is_test_mode() -> bool:
    if os.environ.get(ENV_FLOWPAD_TEST, "").lower() == "true":
        return True
    if ENV_PYTEST_CURRENT_TEST in os.environ:
        return True
    return False


def _is_dev_mode() -> bool:
    return os.environ.get(ENV_FLOWPAD_DEV, "").lower() == "true"


__all__ = [
    "InstanceSettings",
    "BaseInstanceSettings",
    "DevInstanceSettings",
    "TestInstanceSettings",
    "get_instance_settings",
    "reset_instance_settings",
]
