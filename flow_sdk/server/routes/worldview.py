"""Standard-envelope HTTP API for the deployment WorldView."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.worldview.graph import build_worldview
from flow_sdk.worldview.models import LinkArtifactRequest
from flow_sdk.worldview.service import WorldViewServiceError, link_artifact, sync_worldview

router = APIRouter()


@router.get("/api/v1/worldview")
async def get_worldview():
    graph = await build_worldview()
    return ApiSuccessResponse(data=graph.model_dump(mode="json", by_alias=True))


@router.post("/api/v1/worldview/sync")
async def sync_worldview_route():
    graph = await sync_worldview()
    return ApiSuccessResponse(data=graph.model_dump(mode="json", by_alias=True))


@router.post("/api/v1/graph/deployment/{deployment_id}/link-artifact")
async def link_deployment_artifact(deployment_id: str, body: LinkArtifactRequest):
    try:
        deployment = await link_artifact(deployment_id, body.artifact_id)
    except WorldViewServiceError as exc:
        return JSONResponse(
            content=ApiFailResponse(message=str(exc), status_code=400).model_dump(mode="json"),
            status_code=400,
        )
    return ApiSuccessResponse(data=deployment.model_dump(mode="json"))


__all__ = ["router"]
