"""Entity and action loaders for Flow SDK.

Handles loading and registering Pydantic entities via base class inheritance hooks.
"""


def load_entities():
    """Load and register Pydantic entities with the type_registry.

    This imports all Pydantic model modules, which triggers __init_subclass__
    hooks to register entities with the type_registry.

    Note: SQLAlchemy models (in db/sqlalchemy/) are completely separate and
    do NOT register with type_registry.
    """
    # Import Pydantic models to register them with type_registry
    from flow_sdk.models import entities  # noqa: F401


def load_actions():
    """Load and register action handlers.

    This imports all action modules to register @action decorated functions.
    """
    # Import CRUD actions to register them
    # Import watch actions to register them
    from flow_sdk.app.actions import (
        graph_crud_actions,  # noqa: F401
        watch,  # noqa: F401
    )

    # Import compute actions to register them
    try:
        from flow_sdk.app.actions import compute_actions  # noqa: F401
    except ImportError:
        pass  # Compute actions not yet available

    # Import PTY actions to register them
    try:
        from flow_sdk.app.actions import pty_actions  # noqa: F401
    except ImportError:
        pass  # PTY actions not yet available

    # Import env var actions to register them
    from flow_sdk.app.actions import env_var  # noqa: F401

    # Import filesystem actions to register them
    try:
        from flow_sdk.actions.fs import main_fs_action  # noqa: F401
    except ImportError:
        pass  # FS actions not yet available

    # Import desktop-db action to register it
    try:
        from flow_sdk.app.actions import desktop_db  # noqa: F401
    except ImportError:
        pass  # Desktop DB action not available

    # Import secrets action to register it
    try:
        from flow_sdk.app.actions import secrets_action  # noqa: F401
    except ImportError:
        pass  # Secrets action not available

    # Import hooks-sniffer action to register it
    try:
        from flow_sdk.app.actions import hooks_sniffer  # noqa: F401
    except ImportError:
        pass  # Hooks sniffer action not available

    # Import api-keys action to register it
    try:
        from flow_sdk.builtin import api_key  # noqa: F401
    except ImportError:
        pass  # API key action not available

    # NOTE: listen action is NOT registered as a graph action.
    # It is a dedicated route handler called directly from webhook_router
    # (server/routes/webhook.py). Registering it as a graph action causes
    # the graph catch-all's handle_request() to consume the request body
    # before the handler reads it, leading to a hang.

    # Import lm-proxy action to register it
    try:
        from flow_sdk.app.actions import lm_proxy  # noqa: F401
    except ImportError:
        pass  # LM proxy action not available

    # Import repo action to register it
    try:
        from flow_sdk.app.actions import repo_actions  # noqa: F401
    except ImportError:
        pass  # Repo action not available

    # Import MCP action to register it
    try:
        from flow_sdk.app.actions import mcp_actions  # noqa: F401
    except ImportError:
        pass  # MCP action not available

    # Import OAuth action to register it
    try:
        from flow_sdk.app.actions import oauth_action  # noqa: F401
    except ImportError:
        pass  # OAuth action not available

    # Import mcp_app action to register it
    from flow_sdk.actions import mcp_app_action  # noqa: F401


async def is_new_instance(existing, entity_data: dict) -> bool:
    """Check if instance data is newer than existing instance.

    Args:
        existing: The existing entity instance
        entity_data: The new entity data as a dictionary

    Returns:
        True if the entity_data represents a newer instance
    """
    from datetime import datetime

    if not existing:
        return True

    existing_updated = existing.updated_date
    instance_updated_date = entity_data.get("updated_date", None)

    if not instance_updated_date or not existing_updated:
        return False

    if isinstance(instance_updated_date, str):
        # Handle ISO8601 timestamps with optional fractional seconds
        # Replace 'Z' with '+00:00' for fromisoformat compatibility
        iso_str = instance_updated_date.replace("Z", "+00:00")
        update_datetime = datetime.fromisoformat(iso_str)
    elif isinstance(instance_updated_date, datetime):
        update_datetime = instance_updated_date
    else:
        return False

    return existing_updated < update_datetime
