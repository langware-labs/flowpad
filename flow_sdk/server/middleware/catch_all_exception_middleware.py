"""Catch-all exception middleware for minihub.

Catches any unhandled exceptions that escape the request pipeline and
returns them as ApiFailResponse JSON instead of raw 500 errors.

Ported from FlowPad: flowpad/hub/middleware/catch_all_exception_middleware.py
Simplified for desktop — no auth context or telemetry.
"""

import logging
import traceback

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

logger = logging.getLogger(__name__)

# Default request timeout in seconds (5 minutes)
DEFAULT_REQUEST_TIMEOUT = 300


class CatchAllExceptionMiddleware(BaseHTTPMiddleware):
    """Outermost middleware — catches unhandled exceptions and returns ApiFailResponse."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            response = await call_next(request)
            return response
        except Exception as exc:
            # Log the full traceback for debugging
            logger.error(
                f"Unhandled exception in {request.method} {request.url.path}: {exc}\n"
                f"{traceback.format_exc()}"
            )

            # Return ApiFailResponse-shaped JSON
            return JSONResponse(
                status_code=500,
                content={
                    "status": "FAIL",
                    "message": f"Internal server error: {str(exc)}",
                    "data": None,
                },
            )
