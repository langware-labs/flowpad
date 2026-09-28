"""A cloud deployment's token allocation: what the deploy dialog's "Token allocation" sets.

Planning a deployment with one gives it its own hub LLM endpoint, drawn from ``source`` (an endpoint the owner
administers), capped at ``cost_usd_per_day`` and allowing only ``model`` — which the deployed agent then runs.
Without one, the agent spends its owner's capped default.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.schema.data_spec.spec import DataSpec


class TokenAllocationSpec(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "deployment.token_allocation"

    #: The hub endpoint it draws on (``llm_endpoint-<uuid>``).
    source: str
    #: The daily cap in USD; ``None`` = none of its own (the source's caps still apply).
    cost_usd_per_day: Optional[float] = Field(default=None, ge=0)
    #: The one model the deployment may use, and runs (the hub redirects its family to it).
    model: str

    @field_validator("model")
    @classmethod
    def _one_model(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ch in value for ch in "*?["):
            raise ValueError("model must name one model")
        return value


__all__ = ["TokenAllocationSpec"]
