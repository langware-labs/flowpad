"""Collection-level capability routes (not per-entity).

Plural ``capabilities`` is load-bearing: the graph catch-all reads
``/graph/<type>/<id>``, so a singular segment would make it parse ``summary`` as
an id for the ``capability`` entity type.

- ``GET  /api/v1/graph/capabilities/summary`` — the live "all capabilities + how
  to access each" projection (same shape embedded in bootstrap).
- ``POST /api/v1/graph/capabilities/setup-intent`` — resolve a plain-language
  request ("I want email") to a connector and launch its setup agent; returns
  the spawned process id immediately.
- ``POST /api/v1/graph/capabilities/test`` — scoped (project) capability check;
  the project Share/Invite gate's source of truth.

Every route answers in the standard ``{status, data}`` ApiResponse envelope:
the frontend reaches these through ``apiClient``, which unwraps ``data``. A bare
payload here reads back as ``undefined`` in the browser — that is exactly how the
project share gate silently blocked every project with "Couldn't read this
folder's Git status".
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from flow_sdk.core.capabilities.connectors import run_capability_install_for_intent
from flow_sdk.core.capabilities.models import CapabilityKind, CapabilityScope
from flow_sdk.core.capabilities.registry import get_capability_registry
from flow_sdk.core.capabilities.summary import (
    CapabilitiesSummary,
    compute_capabilities_summary,
)
from flow_sdk.responses.response import ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter()


class InstallIntentRequest(BaseModel):
    text: str


class ScopedCapabilityRequest(BaseModel):
    kind: str
    scope_type: str
    scope_id: str


@router.get("/api/v1/graph/capabilities/summary")
async def capabilities_summary() -> ApiSuccessResponse[CapabilitiesSummary]:
    return ApiSuccessResponse[CapabilitiesSummary](data=await compute_capabilities_summary())


@router.post("/api/v1/graph/capabilities/setup-intent")
async def install_intent(body: InstallIntentRequest) -> ApiSuccessResponse[dict]:
    result = await run_capability_install_for_intent(body.text)
    return ApiSuccessResponse[dict](data=result.model_dump(mode="json"))


@router.post("/api/v1/graph/capabilities/test")
async def test_scoped_capability(body: ScopedCapabilityRequest) -> ApiSuccessResponse[dict]:
    if body.kind not in {CapabilityKind.GITHUB.value}:
        raise ValueError(f"Capability {body.kind!r} does not support scoped testing")
    from flow_sdk.builtin.capability import Capability

    row = await Capability.get_or_create_scoped(body.kind, body.scope_type, body.scope_id)
    result = await get_capability_registry().test(
        body.kind,
        scope=CapabilityScope(scope_type=body.scope_type, scope_id=body.scope_id),
    )
    await row._record_result("last_test", result.result, attempted=True)
    return ApiSuccessResponse[dict](data=result.model_dump(mode="json"))
