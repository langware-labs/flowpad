"""
LabelInfo class for managing individual labels in an ontology.
"""

from typing import Optional

from pydantic import BaseModel

# Label delimiter constant
LABEL_DELIMITER = "."


class LabelInfo(BaseModel):
    """Represents a single label in an ontology with metadata."""

    label: str  # e.g., "google.drive.upload"
    description: Optional[str] = None
    parent: Optional[str] = None
    color: Optional[str] = None  # Hex color code for UI representation

    @property
    def keyword(self) -> str:
        """Return the last segment of the label as the 'keyword'."""
        return self.label.split(LABEL_DELIMITER)[-1]

    @property
    def segments(self) -> list[str]:
        """Return all segments of the label."""
        return self.label.split(LABEL_DELIMITER)

    @property
    def parent_label(self) -> Optional[str]:
        """Return the parent label (all segments except the last)."""
        segments = self.segments
        if len(segments) <= 1:
            return None
        return LABEL_DELIMITER.join(segments[:-1])

    def is_child_of(self, parent_label: str) -> bool:
        """Check if this label is a child of the given parent label."""
        return self.label.startswith(f"{parent_label}{LABEL_DELIMITER}")

    def get_depth(self) -> int:
        """Return the depth of this label (number of segments)."""
        return len(self.segments)
