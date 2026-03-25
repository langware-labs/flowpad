"""
Ontology package for knowledge management.

This package contains classes and utilities for managing ontologies and label information.
"""

from .label_info import LABEL_DELIMITER, LabelInfo
from .label_utils import (
    SKILL_ONTOLOGY_NAME,
    get_label_display_name,
    is_ontology_label,
    ontology_to_label,
    ontology_to_label_prefix,
    parse_label,
)
from .ontology import Ontology

__all__ = [
    "Ontology",
    "LabelInfo",
    "LABEL_DELIMITER",
    "SKILL_ONTOLOGY_NAME",
    "ontology_to_label",
    "ontology_to_label_prefix",
    "parse_label",
    "is_ontology_label",
    "get_label_display_name",
]
