"""
Assets route for the local server.

Provides asset-types endpoint for the Asset system.
Tree and backlinks endpoints removed (Asset entity removed).
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/api/v1/assets/types")
async def get_asset_types():
    """Return all record types marked as user_asset=True."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    types = [{"type_name": "project", "label": "Projects", "icon": None}]
    for type_name in SchemaRegistry.get_all_types():
        ti = SchemaRegistry.get(type_name)
        if ti and ti.user_asset:
            types.append({
                "type_name": ti.type_name,
                "label": ti.type_name.replace("_", " ").title(),
                "icon": ti.icon,
            })
    return JSONResponse(content={"status": "SUCCESS", "data": {"types": types}})
