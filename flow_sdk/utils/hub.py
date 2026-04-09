"""Utilities for communicating with the Flowpad Hub (flowpad.ai cloud).

Provides a thin async HTTP client for making authenticated requests to the
hub's graph API. All hub calls should go through these helpers so the base
URL and auth header are managed in one place.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


def hub_base_url() -> str:
    """Return the hub base URL from config (no trailing slash)."""
    from flow_sdk.config import default_service_config
    return default_service_config.flowpad_cloud_url.rstrip("/")


def hub_graph_url(path: str) -> str:
    """Build a full hub graph URL for the given relative path.

    Example: hub_graph_url("cross_notification/send")
      → "https://flowpad.ai/api/v1/graph/cross_notification/send"
    """
    from flow_sdk.api.api_request import APIRequest
    full_path = f"{APIRequest.api_prefix}{APIRequest.graph_prefix}/{path.lstrip('/')}"
    return f"{hub_base_url()}{full_path}"


def _auth_headers() -> dict[str, str]:
    from flow_sdk.cli.auth import get_api_key
    api_key = get_api_key()
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def hub_post(path: str, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    """POST to a hub graph endpoint. Returns the response `data` dict on success, None on failure.

    Args:
        path: Relative graph path, e.g. "cross_notification/send"
        payload: JSON body to send.
    """
    url = hub_graph_url(path)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload, headers=_auth_headers())
            if resp.status_code == 200:
                return resp.json().get("data") or {}
            logger.warning("[hub] POST %s returned %s: %s", path, resp.status_code, resp.text[:200])
            return None
    except Exception as e:
        logger.warning("[hub] POST %s error (non-fatal): %s", path, e)
        return None
