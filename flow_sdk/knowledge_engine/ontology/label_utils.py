"""
Label utility functions for working with ontology-prefixed labels.

This module provides utilities to format and parse labels with ontology prefixes,
matching the frontend implementation for consistent label handling across the stack.

Label Format: --{ontologyName}--.{path}
Examples:
    - --skill--.solution_engineer (skill ontology)
    - --google--.drive.upload (google ontology)
    - manual (ad-hoc label without ontology)
"""

import re
from typing import Optional

# Ontology name constants
SKILL_ONTOLOGY_NAME = "skill"
USER_TYPE_ONTOLOGY_NAME = "user-type"

# User type label paths
USER_TYPE_SYSTEM = "system"
USER_TYPE_DESKTOP = "desktop"


def ontology_to_label_prefix(ontology_name: str) -> str:
    """
    Get the label prefix for an ontology.

    Args:
        ontology_name: The name of the ontology (e.g., 'skill', 'google')

    Returns:
        The label prefix in format: --{ontologyName}--

    Examples:
        >>> ontology_to_label_prefix('skill')
        '--skill--'
        >>> ontology_to_label_prefix('google')
        '--google--'
    """
    return f"--{ontology_name}--"


def ontology_to_label(ontology_name: str, path: str) -> str:
    """
    Convert an ontology name and path to a full label ID.

    Args:
        ontology_name: The name of the ontology (e.g., 'skill', 'google')
        path: The label path within the ontology (e.g., 'solution_engineer', 'drive.upload')

    Returns:
        The full label ID in format: --{ontologyName}--.{path}

    Examples:
        >>> ontology_to_label('skill', 'solution_engineer')
        '--skill--.solution_engineer'
        >>> ontology_to_label('google', 'drive.upload')
        '--google--.drive.upload'
    """
    prefix = ontology_to_label_prefix(ontology_name)
    return f"{prefix}.{path}"


def parse_label(label_id: str) -> tuple[Optional[str], str]:
    """
    Parse a label ID into ontology name and path.

    Args:
        label_id: The label ID to parse

    Returns:
        A tuple of (ontology_name, path). If the label doesn't have an ontology prefix,
        ontology_name will be None and path will be the full label_id.

    Examples:
        >>> parse_label('--skill--.solution_engineer')
        ('skill', 'solution_engineer')
        >>> parse_label('--google--.drive.upload')
        ('google', 'drive.upload')
        >>> parse_label('manual')
        (None, 'manual')
    """
    match = re.match(r"^--([^-]+)--\.(.+)$", label_id)
    if not match:
        # Ad-hoc label without ontology prefix
        return None, label_id
    return match.group(1), match.group(2)


def is_ontology_label(label_id: str, ontology_name: str) -> bool:
    """
    Check if a label belongs to a specific ontology.

    Args:
        label_id: The label ID to check
        ontology_name: The ontology name to check against

    Returns:
        True if the label belongs to the specified ontology, False otherwise

    Examples:
        >>> is_ontology_label('--skill--.solution_engineer', 'skill')
        True
        >>> is_ontology_label('--google--.drive.upload', 'skill')
        False
        >>> is_ontology_label('manual', 'skill')
        False
    """
    ontology, _ = parse_label(label_id)
    return ontology == ontology_name


def get_label_display_name(label_id: str) -> str:
    """
    Get the display name for a label (last segment of the path).

    Args:
        label_id: The label ID

    Returns:
        The last segment of the label path

    Examples:
        >>> get_label_display_name('--skill--.solution_engineer')
        'solution_engineer'
        >>> get_label_display_name('--google--.drive.upload')
        'upload'
        >>> get_label_display_name('manual')
        'manual'
    """
    _, path = parse_label(label_id)
    return path.split(".")[-1]


def get_user_type_label(user_type: str) -> str:
    """
    Get the full label for a user type.

    Args:
        user_type: The user type (e.g., 'system', 'desktop')

    Returns:
        The full user type label in format: --user-type--.{user_type}

    Examples:
        >>> get_user_type_label('system')
        '--user-type--.system'
        >>> get_user_type_label('desktop')
        '--user-type--.desktop'
    """
    return ontology_to_label(USER_TYPE_ONTOLOGY_NAME, user_type)


def get_system_user_label() -> str:
    """Get the label for system users."""
    return get_user_type_label(USER_TYPE_SYSTEM)


def get_desktop_user_label() -> str:
    """Get the label for desktop users."""
    return get_user_type_label(USER_TYPE_DESKTOP)
