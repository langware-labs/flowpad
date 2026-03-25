import re
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel

from flow_sdk.builtin.knowledge_base.Knowledge_types import KnowledgeEntryType


class KnowledgeEntry(BaseModel):
    """Base class for all knowledge entries."""

    id: str
    labels: List[str]  # List of ontology label strings (e.g., ["google.drive.upload"])
    content: Union[str, Dict[str, Any]]  # Text, code, dict, etc.
    content_type: str  # "text", "code", "table", "image", etc.
    entry_type: KnowledgeEntryType = KnowledgeEntryType.CONTEXT  # "context" or "instruction"
    embeddings: List[List[float]] = []  # Multiple embeddings supported
    version: int = 1
    valid: bool = True
    name: Optional[str] = None  # Name for dependency tree resolution

    def invalidate(self):
        """Mark entry as invalid (for invalidation/updating)."""
        self.valid = False

    @property
    def dependencies(self) -> List[str]:
        """
        Extract dependencies from template string using regex to find all {parameter} placeholders.

        Returns:
            List[str]: List of parameter names this entry depends on
        """
        if not isinstance(self.content, str):
            return []

        # Find all {parameter} placeholders in the content
        pattern = r"\{([^}]+)\}"
        matches = re.findall(pattern, self.content)

        # Return unique dependencies maintaining order
        seen = set()
        dependencies = []
        for match in matches:
            if match not in seen:
                dependencies.append(match)
                seen.add(match)

        return dependencies

    def generate_instructions(self, context_dict: Dict[str, Any]) -> str:
        """
        Generate instructions by replacing placeholders in content with context values.

        Args:
            context_dict: Dictionary containing key-value pairs for replacement

        Returns:
            str: The instruction content with all placeholders replaced

        Raises:
            KeyError: If a required placeholder key is not found in context_dict
        """
        if not isinstance(self.content, str):
            raise ValueError("generate_instructions only works with string content")

        try:
            return self.content.format(**context_dict)
        except KeyError as e:
            raise KeyError(f"Missing required context key: {e.args[0]}") from e
