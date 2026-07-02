"""
Health check routes - lightweight status endpoints.

Ported from FlowPad: flowpad/hub/routers/health_checks.py
"""

import platform
import sys

from fastapi import APIRouter

from flow_sdk.responses.response import ApiResponse, ApiResponseStatus, ApiSuccessResponse

health_router = APIRouter()


@health_router.get("/status")
def health_check():
    return ApiResponse[bool](data=True, message="Flowpad is up and running", status=ApiResponseStatus.SUCCESS)


@health_router.get("/version")
def health_version():
    """Return app version info.

    ``version`` must be the REAL installed package version: the Electron shell
    compares it against the on-disk install to decide whether an
    already-running backend can be adopted (reused) instead of killed and
    rebooted. A wrong value here forces a needless ~13s reboot on every
    launch after a crash/force-quit — or worse, adopts a stale backend.
    """
    from flow_sdk._version import __version__

    version_info = {
        "app": "flow-cli",
        "version": __version__,
        "python": sys.version,
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "node": platform.node(),
    }
    return ApiSuccessResponse(data=version_info)


@health_router.post("/clear-caches")
def health_clear_caches():
    """Clear any in-memory caches.

    In desktop mode, this clears the entity cache and uname cache.
    Returns success even if caches were already empty.
    """
    cleared = []
    try:
        from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache
        entity_cache.clear()
        uname_cache.clear()
        cleared.extend(["entity_cache", "uname_cache"])
    except ImportError:
        pass

    return ApiSuccessResponse(
        data={"cleared": cleared, "message": "Caches cleared successfully"}
    )
