"""Standard-envelope HTTP API for the deployment WorldView."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse
from flow_sdk.worldview.graph import build_worldview
from flow_sdk.worldview.models import LinkArtifactRequest, WorldViewProjection
from flow_sdk.worldview.service import WorldViewServiceError, link_artifact, sync_worldview

router = APIRouter()

_SUPPORTED_PROJECTIONS = (WorldViewProjection.DEPLOYMENT,)


def _unsupported_projection(projection: str) -> JSONResponse:
    return JSONResponse(
        content=ApiFailResponse(
            message=f"WorldView projection '{projection}' is not supported by this backend",
            data={
                "code": "worldview_projection_not_supported",
                "supported_projections": [item.value for item in _SUPPORTED_PROJECTIONS],
            },
            status_code=400,
        ).model_dump(mode="json"),
        status_code=400,
    )


def _is_supported_projection(projection: str) -> bool:
    return projection in _SUPPORTED_PROJECTIONS


@router.get("/api/v1/worldview")
async def get_worldview():
    return await get_worldview_projection(WorldViewProjection.DEPLOYMENT.value)


@router.post("/api/v1/worldview/sync")
async def sync_worldview_route():
    return await refresh_worldview_projection(WorldViewProjection.DEPLOYMENT.value)


@router.get("/api/v1/worldview/{projection}")
async def get_worldview_projection(projection: str):
    if not _is_supported_projection(projection):
        return _unsupported_projection(projection)
    graph = await build_worldview()
    return ApiSuccessResponse(data=graph.model_dump(mode="json", by_alias=True))


@router.post("/api/v1/worldview/{projection}/refresh")
async def refresh_worldview_projection(projection: str):
    if not _is_supported_projection(projection):
        return _unsupported_projection(projection)
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
