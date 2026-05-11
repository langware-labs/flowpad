"""AgenticProcess event names shared by the entity and worker drivers."""

from flow_sdk._compat import StrEnum


class AgenticProcessEventName(StrEnum):
    """Events reported from clients to the running worker integration."""

    FIRST_PROMPT = "first_prompt"
