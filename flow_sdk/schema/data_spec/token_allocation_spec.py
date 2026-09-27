"""A cloud deployment's token allocation: what the deploy dialog's "Token allocation" sets.

Planning a deployment with one gives it its own hub LLM endpoint, drawn from ``source`` (an endpoint the owner
administers), capped at ``cost_usd_per_day`` and allowing only ``model`` — which the deployed agent then runs.
Without one, the agent spends its owner's capped default.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.spec import DataSpec


class TokenAllocationSpec(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "deployment.token_allocation"

    #: The hub endpoint it draws on (``llm_endpoint-<uuid>``).
    source: str
    #: The daily cap in USD; ``None`` = none of its own (the source's caps still apply).
    cost_usd_per_day: Optional[float] = Field(default=None, ge=0)
    #: The one model the deployment may use, and runs.
    model: str


__all__ = ["TokenAllocationSpec"]
