from enum import StrEnum


class KnowledgeEntryType(StrEnum):
    """Enum for knowledge entry types."""

    CONTEXT = "context"
    INSTRUCTION = "instruction"
