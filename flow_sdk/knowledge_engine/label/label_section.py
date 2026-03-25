"""
LabelSection class for managing sections within lexical documents based on labels.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from flow_sdk.knowledge_engine.ontology import LabelInfo


class LabelSection(BaseModel):
    """Represents a section in a document identified by labels."""

    label: str  # The primary label for this section
    title: Optional[str] = None  # Human-readable title for the section
    content: str = ""  # Text content of the section
    subsections: List["LabelSection"] = []  # Nested subsections
    metadata: Dict[str, Any] = {}  # Additional metadata
    priority: int = 1  # Priority for ordering (higher = more important)

    @property
    def depth(self) -> int:
        """Return the depth of this section based on label segments."""
        return len(self.label.split("."))

    @property
    def keyword(self) -> str:
        """Return the last segment of the label as the keyword."""
        return self.label.split(".")[-1]

    def add_subsection(self, subsection: "LabelSection") -> None:
        """Add a subsection to this section."""
        self.subsections.append(subsection)

    def find_subsection(self, label: str) -> Optional["LabelSection"]:
        """Find a subsection by label."""
        for subsection in self.subsections:
            if subsection.label == label:
                return subsection
            # Recursively search in nested subsections
            found = subsection.find_subsection(label)
            if found:
                return found
        return None

    def get_all_labels(self) -> List[str]:
        """Get all labels from this section and its subsections."""
        labels = [self.label]
        for subsection in self.subsections:
            labels.extend(subsection.get_all_labels())
        return labels

    def is_parent_of(self, other_label: str) -> bool:
        """Check if this section's label is a parent of another label."""
        return other_label.startswith(f"{self.label}.")

    def get_content_length(self) -> int:
        """Get the total content length including subsections."""
        total_length = len(self.content)
        for subsection in self.subsections:
            total_length += subsection.get_content_length()
        return total_length

    def flatten(self) -> List["LabelSection"]:
        """Return a flat list of this section and all subsections."""
        result = [self]
        for subsection in self.subsections:
            result.extend(subsection.flatten())
        return result

    def to_markdown(self, level: int = 1) -> str:
        """Convert this section to markdown format."""
        heading = "#" * level
        title = self.title or self.keyword.replace("_", " ").title()

        markdown = f"{heading} {title}\n\n"
        if self.content:
            markdown += f"{self.content}\n\n"

        # Add subsections
        for subsection in self.subsections:
            markdown += subsection.to_markdown(level + 1)

        return markdown

    @classmethod
    def from_label_info(cls, label_info: LabelInfo, content: str = "") -> "LabelSection":
        """Create a LabelSection from a LabelInfo object."""
        return cls(
            label=label_info.label,
            title=label_info.description,
            content=content,
            metadata={"color": label_info.color} if label_info.color else {},
        )


# Fix forward reference
LabelSection.model_rebuild()
