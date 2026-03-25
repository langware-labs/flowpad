"""
Label package for knowledge management.

This package contains classes and utilities for managing labels, label sections,
and label-related operations within the knowledge management system.
"""

from .label_manager import LabelManager
from .label_section import LabelSection

__all__ = [
    "LabelSection",
    "LabelManager",
]
