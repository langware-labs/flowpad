"""Endpoint-owned text-generation model selection, independent of worker defaults."""

from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict

from flow_sdk.external_apis.llm.errors import LLMError

TEXT_TIERS = frozenset({"sm", "md", "lg"})


def clean_default_model(value: str | None) -> str | None:
    return value.strip() or None if value is not None else None


def resolve_completion_model(
    tiers: Mapping[str, str | None], model: str | None = None, *, default_model: str | None = None
) -> str:
    """An explicit selection wins; only an absent declaration falls back to sm."""
    selector = clean_default_model(model) or clean_default_model(default_model) or "sm"
    if selector == "embedding":
        raise LLMError("The embedding model cannot be selected for text generation")
    selected = tiers.get(selector) if selector in TEXT_TIERS or selector in tiers else selector
    if not selected or selected in TEXT_TIERS or selected == "embedding":
        raise LLMError(f"No text-generation model is configured for {selector!r}")
    return selected


class EndpointModelConfig(BaseModel):
    """The hub's narrow model projection. Null effective default is unavailable."""

    model_config = ConfigDict(extra="forbid")
    endpoint_typeid: str
    tiers: dict[str, str | None]
    default_model: str | None
    effective_default_model: str | None

    def resolve(self, model: str | None = None) -> str:
        if model:
            return resolve_completion_model(self.tiers, model)
        if not self.effective_default_model:
            raise LLMError("This endpoint has no available default text-generation model")
        return resolve_completion_model({}, self.effective_default_model)
