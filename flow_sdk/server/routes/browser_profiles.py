"""The terminal link menu's "Open in ▸ browser / profile" — over ``flow_sdk.core.browser_profiles``.

Only meaningful when this backend runs on the user's own machine: a sandbox or
agent box (``get_assigned_runtime()`` set) would list and launch browsers on a
machine nobody is looking at, so both verbs refuse there with ``NOT_LOCAL``.
Refusals are HTTP errors carrying the envelope (``error_code`` + the sentence),
so ``apiClient`` rejects and the menu toasts the backend's reason. Plain ``def`` handlers — discovery reads files and may touch the registry, so
FastAPI runs them in its threadpool.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from flow_sdk.core.browser_profiles import (
    BrowserProfileError,
    OpenInProfileRequest,
    list_browser_profiles,
    open_in_profile,
)
from flow_sdk.instance_settings.runtime import get_assigned_runtime
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()


def _fail(status: int, error_code: str, message: str) -> JSONResponse:
    body = ApiFailResponse(message=message, data={"error_code": error_code})
    return JSONResponse(content=body.model_dump(mode="json"), status_code=status)


def _not_local() -> JSONResponse | None:
    kind = get_assigned_runtime()
    return None if kind is None else _fail(403, "NOT_LOCAL", f"this backend runs as {kind}, not on your machine")


@router.get("/api/v1/browser-profiles")
def browser_profiles():
    if refused := _not_local():
        return refused
    return ApiSuccessResponse(data=list_browser_profiles())


@router.post("/api/v1/browser-profiles/open")
def browser_profiles_open(req: OpenInProfileRequest):
    if refused := _not_local():
        return refused
    try:
        open_in_profile(req)
    except BrowserProfileError as exc:
        return _fail(400, exc.code, str(exc))
    return ApiSuccessResponse(data={"opened": True})
