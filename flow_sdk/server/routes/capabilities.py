"""Collection-level capability routes (not per-entity).

- ``GET  /api/v1/graph/capabilities/summary`` — the live "all capabilities +
  how to access each" projection (same shape embedded in bootstrap). Plural
  ``capabilities`` so it never collides with the per-id ``/graph/capability/{id}``
  entity matcher.
- ``POST /api/v1/graph/capabilities/install-intent`` — resolve a plain-language
  request ("I want email") to a connector and launch its setup agent; returns
  the spawned process id immediately.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from flow_sdk.core.capabilities.connectors import run_capability_install_for_intent
from flow_sdk.core.capabilities.summary import (
    CapabilitiesSummary,
    compute_capabilities_summary,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class InstallIntentRequest(BaseModel):
    text: str


@router.get("/api/v1/graph/capabilities/summary", response_model=CapabilitiesSummary)
async def capabilities_summary() -> CapabilitiesSummary:
    return await compute_capabilities_summary()


@router.post("/api/v1/graph/capabilities/install-intent")
async def install_intent(body: InstallIntentRequest) -> dict:
    result = await run_capability_install_for_intent(body.text)
    return result.model_dump(mode="json")
