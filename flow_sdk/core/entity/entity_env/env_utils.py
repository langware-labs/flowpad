"""Utility functions for environment variable handling."""

from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.core.entity.entity_env.env_types import EnvVarType


def build_sod_key(entity_type_id: TypeId, var_name: str) -> str:
    """Build a key for storing environment variables in SOD (Secure Object Database).

    Args:
        entity_type_id: The entity's TypeId
        var_name: The environment variable name

    Returns:
        A unique key string for SOD storage
    """
    return f"{entity_type_id}_{var_name}"


def is_confidential(var_type: EnvVarType) -> bool:
    """Check if an environment variable type should be treated as confidential.

    Args:
        var_type: The environment variable type

    Returns:
        True if the variable type is confidential (API_KEY or OAUTH_TOKEN)
    """
    return var_type in (EnvVarType.API_KEY, EnvVarType.OAUTH_TOKEN)


def mask_confidential_value(value: str) -> str:
    """Mask a confidential value, showing only the last 4 characters.

    Args:
        value: The value to mask

    Returns:
        Masked value string (e.g., "****abcd")
    """
    if len(value) <= 4:
        return "****"
    return f"****{value[-4:]}"


def build_shared_var_name(var_name: str, target_entity_type: str) -> str:
    """Build a shared environment variable name.

    Args:
        var_name: The base variable name
        target_entity_type: The target entity type

    Returns:
        Formatted shared variable name (e.g., "GITHUB_OF_PROJECT")
    """
    return f"{var_name}_OF_{target_entity_type.upper()}"
