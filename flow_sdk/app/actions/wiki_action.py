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
        # Body source priority:
        #   1. POST body `{"body": "..."}` if provided — for callers that
        #      already have the body in hand (out-of-band fs writes via FsRef).
        #   2. Otherwise, load the record and read its wiki_body().
        body: str | None = None
        try:
            data = await info.get_post_data()
        except Exception:
            data = None
        if isinstance(data, dict) and "body" in data:
            body = data["body"]
        else:
            record_cls = SchemaRegistry.get_record_cls(typeid.type)
            if record_cls is not None:
                record = record_cls.get(str(typeid.id))
                if record is not None:
                    body = record.wiki_body()

        wiki.index(typeid.type, str(typeid.id), body)
        edges = wiki.outgoing(typeid.type, str(typeid.id))
        return ApiSuccessResponse(data=[_link_to_dict(e) for e in edges])

    return ApiFailResponse(
        message=f"Unknown wiki action: {method} sub-path={sub!r}",
        status_code=404,
    )
