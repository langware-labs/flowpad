"""
MCP app action — serves a pre-built SPA from an entity's record folder.

URL: GET /api/v1/graph/{type}/{id}/mcp_app/{app_name}/{file_path?}
     ?appContext=<json>   (optional, read client-side by the app)

MCP app dist lives at: entity.record.record_dir / "mcp_apps" / app_name / "dist"
MCP apps must be built with base: './' (relative asset paths).
"""
from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context import get_current_request_info


@action.get(action_name="mcp_app", types="all")
async def serve_mcp_app(self, request: Request) -> Response:
    request_info = get_current_request_info()
    sub_path = (request_info.sub_path or "").strip("/")

    # sub_path = "{app_name}" or "{app_name}/{file...}"
    parts = sub_path.split("/", 1)
    app_name = parts[0]
    file_path = parts[1] if len(parts) > 1 else ""

    if not app_name:
        return HTMLResponse("Missing app name", status_code=400)

    # Resolve record folder
    record = self.record
    if not record or not record.record_dir:
        return HTMLResponse("Entity has no record folder", status_code=404)

    dist_dir = (record.record_dir / "mcp_apps" / app_name / "dist").resolve()
    if not dist_dir.is_dir():
        return HTMLResponse(f"MCP app '{app_name}' not found", status_code=404)

    # Serve static file if path given and file exists
    if file_path:
        candidate = (dist_dir / file_path).resolve()
        # Path traversal guard
        try:
            candidate.relative_to(dist_dir)
        except ValueError:
            return HTMLResponse("Forbidden", status_code=403)
        if candidate.is_file():
            return FileResponse(candidate)

    # SPA fallback — serve index.html
    index = dist_dir / "index.html"
    if not index.exists():
        return HTMLResponse(f"MCP app '{app_name}' has no index.html", status_code=404)
    return HTMLResponse(content=index.read_text(), media_type="text/html")
