"""Action registry stub for API request parsing.

This is a minimal implementation to support api_request.py's action detection.
"""


def is_action(action_name: str, entity_type: str | None = None) -> bool:
    """Check if a string is an action name.

    Args:
        action_name: The potential action name to check
        entity_type: Optional entity type to check actions for specific entities

    Returns:
        bool: True if the name appears to be an action (heuristic)
    """
    # Simple heuristic: actions often start with common verbs or patterns
    # This is a stub that returns False to avoid blocking imports
    return False
