"""Non-secret local provider configuration and catalog metadata."""

from typing import Literal

from flow_sdk.schema.data_spec.spec import DataSpec


class VertexConfig(DataSpec):
    project_id: str = ""
    location: str = ""


class LLMModelInfo(DataSpec):
    id: str
    name: str
    formats: list[Literal["chat", "messages", "responses", "embeddings"]] | None = None
    catalog_source: Literal["declared", "discovered"] = "discovered"
