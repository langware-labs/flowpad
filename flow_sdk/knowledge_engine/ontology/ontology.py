"""
Ontology class for managing structured collections of labels.
"""

import logging
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from .label_info import LabelInfo


class Ontology(BaseModel):
    """Model representing the ontology - a structured collection of labels."""

    labels: Dict[str, LabelInfo] = Field(
        default_factory=dict, description="Dictionary of label_id -> LabelInfo mappings"
    )

    @property
    def label_ids(self) -> List[str]:
        """Get all label IDs in the ontology."""
        return list(self.labels.keys())

    def find_label(self, label: str) -> Optional[LabelInfo]:
        """Find a label by its label string."""
        return self.labels.get(label)

    def add_label(self, label_info: LabelInfo) -> bool:
        """Add a label to the ontology. Returns True if added, False if already exists."""
        label_exists = label_info.label in self.labels
        self.labels[label_info.label] = label_info
        return not label_exists

    def add_labels(self, label_list_str: List[str]):
        """Add multiple labels to the ontology from string list."""
        for label in label_list_str:
            label_info = LabelInfo(label=label)
            self.add_label(label_info)

    def remove_label(self, label_id: str) -> bool:
        """Remove a label from the ontology. Returns True if removed, False if not found."""
        if label_id in self.labels:
            del self.labels[label_id]
            return True
        return False

    def update_label(self, label: str, **updates) -> bool:
        """Update a label's properties. Returns True if updated, False if not found."""
        label_info = self.find_label(label)
        if label_info:
            for key, value in updates.items():
                if hasattr(label_info, key):
                    setattr(label_info, key, value)
            return True
        return False

    def get_root_labels(self) -> List[LabelInfo]:
        """Get all root labels (labels with no parent)."""
        return [label_info for label_info in self.labels.values() if "." not in label_info.label]

    def get_children_of(self, parent_label: str) -> List[LabelInfo]:
        """Get all direct children of a parent label."""
        children = []
        for label_info in self.labels.values():
            if label_info.is_child_of(parent_label):
                # Check if it's a direct child (one level deeper)
                parent_depth = len(parent_label.split("."))
                if label_info.get_depth() == parent_depth + 1:
                    children.append(label_info)
        return children

    def get_all_descendants_of(self, parent_label: str) -> List[LabelInfo]:
        """Get all descendants (children, grandchildren, etc.) of a parent label."""
        return [label_info for label_info in self.labels.values() if label_info.is_child_of(parent_label)]

    def get_labels_by_keyword(self, keyword: str) -> List[LabelInfo]:
        """Get all labels that end with the given keyword."""
        return [label_info for label_info in self.labels.values() if label_info.keyword == keyword]

    def get_all_keywords(self) -> List[str]:
        """Get all unique keywords (last segments) from all labels."""
        return list(set(label_info.keyword for label_info in self.labels.values()))

    def __len__(self) -> int:
        """Return the number of labels in the ontology."""
        return len(self.labels)

    def merge(self, other_ontology: "Ontology", warn_on_duplicates: bool = True) -> None:
        """
        Merge another ontology into this one.
        If two keys exist, the loaded ontology overwrites the existing key/value.

        Args:
            other_ontology: The ontology to merge into this one
            warn_on_duplicates: Whether to log warnings for duplicate keys
        """
        if other_ontology:
            if warn_on_duplicates:
                # Check for duplicate keys and warn
                duplicates = set(self.labels.keys()) & set(other_ontology.labels.keys())
                if duplicates:
                    logging.warning(
                        f"Merging ontology: {len(duplicates)} duplicate label(s) will be overwritten: "
                        f"{', '.join(sorted(duplicates))}"
                    )
            self.labels.update(other_ontology.labels)

    def __iter__(self):
        """Allow iteration over labels."""
        return iter(self.labels.values())
