"""Wiki link action — exposes the in-process `flow_sdk.wiki` layer over HTTP.

URL surface:
    GET  /api/v1/graph/{type}/{id}/wiki/links      → outgoing edges from this entity
    GET  /api/v1/graph/{type}/{id}/wiki/backlinks  → inbound edges pointing at this entity
    POST /api/v1/graph/{type}/{id}/wiki/reindex    → re-extract this entity's outgoing edges
                                                     from its current `wiki_body()` (used after
                                                     out-of-band body writes via FrontMatterFsRef)

Mirrors the single-action sub-path pattern used by `mcp_app_action.py:17`.
The graph router catch-all dispatches to this handler; the handler reads
`request_info.sub_path` to branch.
"""

from fastapi import HTTPException

from flow_sdk import wiki
from flow_sdk.actions import action
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


def _link_to_dict(link) -> dict:
    return {
        "id":          link.id,
        "src_type":    link.src_type,
        "src_id":      link.src_id,
        "raw":         link.raw,
        "target_type": link.target_type,
        "target_id":   link.target_id,
        "line":        link.line,
    }


@action.all(action_name="wiki", methods=["get", "post"], types="all")
async def wiki_action():
    """One handler for both GET and POST; branches on (method, sub_path)."""
    info = get_current_request_info()
    if not info:
        raise HTTPException(status_code=400, detail="invalid request info")
    if info.target_entity_typeid is None:
        raise HTTPException(status_code=400, detail="wiki action requires target entity")

    method = (info.method or "").upper()
    sub = (info.sub_path or "").strip("/").split("/", 1)[0]
    typeid = info.target_entity_typeid

    if method == "GET" and sub == "links":
        edges = wiki.outgoing(typeid.type, str(typeid.id))
        return ApiSuccessResponse(data=[_link_to_dict(e) for e in edges])

    if method == "GET" and sub == "backlinks":
        edges = wiki.backlinks(typeid.type, str(typeid.id))
        return ApiSuccessResponse(data=[_link_to_dict(e) for e in edges])

    if method == "POST" and sub == "reindex":
        # Optional `{"body": "..."}` payload — callers that already have the
        # body skip the record load (e.g. the editor toolbar after an
        # out-of-band insert). Otherwise Entity.reindex loads it from disk.
        body: str | None = None
        try:
            data = await info.get_post_data()
        except Exception:
            data = None
        if isinstance(data, dict) and "body" in data:
            body = data["body"]

        # Delegate to Entity.reindex so all reindex paths share one impl.
        from flow_sdk.core.entity.entity_model import Entity
        from flow_sdk.db.drivers.query import QueryFilter

        entity_cls = SchemaRegistry.get_entity_cls(typeid.type) or Entity
        entity = await entity_cls.get_one(QueryFilter.parse({"id": str(typeid.id)}))
        if entity is None:
            # Entity row hasn't been created yet — index from body directly.
            wiki.index(typeid.type, str(typeid.id), body)
            return ApiSuccessResponse(
                data=[_link_to_dict(e) for e in wiki.outgoing(typeid.type, str(typeid.id))]
            )

        edges = await entity.reindex(body)
        return ApiSuccessResponse(data=edges)

    return ApiFailResponse(
        message=f"Unknown wiki action: {method} sub-path={sub!r}",
        status_code=404,
    )
