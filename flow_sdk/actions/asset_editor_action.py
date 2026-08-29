"""``GET /api/v1/graph/{type}/{id}/editor/{name}/{path…}`` — serve an asset's
editor app. One action for every type; the bytes come from the same
``serve_app_bytes`` that serves a ``MicroApp``."""

from fastapi import Request
from fastapi.responses import Response

from flow_sdk.actions.action_registry import action
from flow_sdk.assets.asset_editors import asset_editor_root
from flow_sdk.builtin.faas.serve_static import serve_app_bytes
from flow_sdk.config import default_service_config
from flow_sdk.request_context import get_current_request_info


@action.get(action_name="editor", types="all")
async def serve_asset_editor(self, request: Request) -> Response:
    name, _, tail = (get_current_request_info().sub_path or "").strip("/").partition("/")
    root = asset_editor_root(self, name)
    if root is None:
        return Response(content=f"No editor '{name}' on {self.get_type()}:{self.id}", status_code=404)
    return await serve_app_bytes(
        root, tail, request, api_url_scheme=default_service_config.service_urls_config.api_url_scheme
    )
