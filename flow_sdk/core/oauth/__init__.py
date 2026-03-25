"""
Stub OAuth module for flow-cli (local mode).

OAuth is a cloud-only feature. These stubs provide no-op implementations
so that modules like instruction_context.py can import without errors.
"""

from typing import List

from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVar


class OAuthProviderInfo:
    """Stub OAuth provider info."""

    def __init__(self, name: str = "", display_name: str = "", icon: str = ""):
        self.name = name
        self.display_name = display_name
        self.icon = icon


async def get_available_oauth_providers() -> List[OAuthProviderInfo]:
    """Return empty list -- OAuth is not available in local mode."""
    return []


async def get_oauth_providers_as_env_table() -> EntityEnvVars:
    """Return empty env table -- OAuth is not available in local mode."""
    return EntityEnvVars(values=[])
