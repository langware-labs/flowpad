"""Settings module for Flow SDK — thin shim over flow_sdk.config."""

# DeployEnv and is_desktop live in config.py (the authoritative source).
# This module re-exports them for backwards compatibility.

from flow_sdk.config import DeployEnv, default_service_config  # noqa: F401


def is_desktop() -> bool:
    """Check if running in desktop environment."""
    return default_service_config.is_desktop
