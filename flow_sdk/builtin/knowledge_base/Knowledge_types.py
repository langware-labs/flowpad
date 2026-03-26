from flow_sdk._compat import StrEnum


class KnowledgeEntryType(StrEnum):
    """Enum for knowledge entry types."""

    CONTEXT = "context"
    INSTRUCTION = "instruction"
