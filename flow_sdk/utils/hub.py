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


def hub_base_url() -> Optional[str]:
    """Return the hub base URL from config, or None if not configured."""
    from flow_sdk.config import default_service_config
    url = default_service_config.flowpad_hub_url
    return url.rstrip("/") if url else None


def hub_graph_url(path: str) -> Optional[str]:
    """Build a full hub graph URL for the given relative path, or None if hub is not configured.

    Example: hub_graph_url("notification/send")
      → "http://localhost:8093/api/v1/graph/notification/send"
    """
    base = hub_base_url()
    if not base:
        return None
    from flow_sdk.api.api_request import APIRequest
    full_path = f"{APIRequest.api_prefix}{APIRequest.graph_prefix}/{path.lstrip('/')}"
    return f"{base}{full_path}"


def _auth_headers() -> dict[str, str]:
    from flow_sdk.cli.auth import get_api_key
    api_key = get_api_key()
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def hub_post(path: str, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    """POST to a hub graph endpoint. Returns the response `data` dict on success, None on failure.

    Returns None immediately if FLOWPAD_HUB_URL is not configured.
    """
    url = hub_graph_url(path)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping POST to %s", path)
        return None
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
