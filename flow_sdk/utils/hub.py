"""Utilities for communicating with the Flowpad Hub (flowpad.ai cloud).

Provides a thin async HTTP client for making authenticated requests to the
hub's graph API. All hub calls should go through these helpers so the base
URL and auth header are managed in one place.

URL structure follows the Flowpad Hub API guidelines:
  /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}]
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Optional

import httpx

if TYPE_CHECKING:
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)


def hub_base_url() -> Optional[str]:
    """Return the hub base URL from config, or None if not configured."""
    from flow_sdk.config import default_service_config
    url = default_service_config.flowpad_hub_url
    return url.rstrip("/") if url else None


def hub_graph_url(
    entity_type: "BuiltinEntityType",
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[str]:
    """Build a full hub graph URL per API guidelines, or None if hub is not configured.

    URL pattern:
      /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}[/{sub_path}]]

    Examples:
      hub_graph_url("notification")
        → ".../api/v1/graph/notification"                           (list / create)
      hub_graph_url("notification", "notif-123")
        → ".../api/v1/graph/notification/notif-123"                 (get / update / delete)
      hub_graph_url("notification", "notif-123", "open")
        → ".../api/v1/graph/notification/notif-123/open"            (action on entity)
      hub_graph_url("workspace", "ws-123", "fs", "download/report.pdf")
        → ".../api/v1/graph/workspace/ws-123/fs/download/report.pdf" (fs action with sub_path)
      hub_graph_url("page", "pg-456", scope=[("workspace", "ws-123")])
        → ".../api/v1/graph/workspace/ws-123/page/pg-456"           (scoped entity)
    """
    entity_type_str = entity_type.value
    if sub_path and not action:
        raise ValueError(
            f"sub_path '{sub_path}' requires an action "
            f"(URL pattern: {{entity_type}}/{{entity_id}}/{{action}}/{{sub_path}})"
        )
    base = hub_base_url()
    if not base:
        return None
    from flow_sdk.api.api_request import APIRequest
    segments: list[str] = []
    if scope:
        for scope_type, scope_id in scope:
            segments.extend([scope_type, scope_id])
    segments.append(entity_type_str)
    if entity_id:
        segments.append(entity_id)
    if action:
        segments.append(action)
    if sub_path:
        segments.append(sub_path.lstrip("/"))
    full_path = f"{APIRequest.api_prefix}{APIRequest.graph_prefix}/{'/'.join(segments)}"
    return f"{base}{full_path}"


def _auth_headers() -> dict[str, str]:
    import os
    api_key = os.environ.get("FLOWPAD_CLOUD_API_KEY") or None
    if not api_key:
        from flow_sdk.cli.auth import get_api_key
        api_key = get_api_key()
    if api_key:
        logger.warning("[hub] using key: %s...%s", api_key[:8], api_key[-4:])
    else:
        logger.warning("[hub] no API key found")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def hub_get(
    entity_type: "BuiltinEntityType",
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
    params: dict[str, str] | None = None,
    raw: bool = False,
) -> Optional[dict[str, Any] | bytes]:
    """GET a hub graph endpoint. Returns the response on success, None on failure.

    Returns None immediately if FLOWPAD_HUB_URL is not configured.

    Args:
        entity_type: The entity type (e.g. "notification", "task").
        entity_id:   The entity ID. Required when action is given.
        action:      Optional action name (requires entity_id).
        sub_path:    Optional sub-path appended after action (e.g. "download/report.pdf" for fs).
        scope:       Optional list of (entity_type, entity_id) pairs that prefix the path.
        params:      Optional query parameters (e.g. {"since": "<iso-timestamp>"}).
        raw:         If True, return raw bytes instead of parsing JSON (for file downloads).
    """
    url = hub_graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping GET %s/%s", entity_type, entity_id)
        return None
    try:
        timeout = 60 if raw else 10
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=_auth_headers(), params=params or {})
            if resp.status_code == 200:
                return resp.content if raw else resp.json().get("data") or {}
            logger.warning("[hub] GET %s returned %s: %s", url, resp.status_code, resp.text[:200])
            return None
    except Exception as e:
        logger.warning("[hub] GET %s error (non-fatal): %s", url, e)
        return None


async def hub_post(
    entity_type: "BuiltinEntityType",
    payload: dict[str, Any],
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
    files: dict | None = None,
) -> Optional[dict[str, Any]]:
    """POST to a hub graph endpoint. Returns the response `data` dict on success, None on failure.

    Returns None immediately if FLOWPAD_HUB_URL is not configured.

    Args:
        entity_type: The entity type (e.g. "notification", "task").
        payload:     The JSON body to POST (ignored when files is set).
        entity_id:   The entity ID. Required when action is given.
        action:      Optional action name (requires entity_id).
        sub_path:    Optional sub-path appended after action (e.g. "upload/report.pdf" for fs).
        scope:       Optional list of (entity_type, entity_id) pairs that prefix the path.
        files:       If set, sends a multipart request instead of JSON (for file uploads).
    """
    url = hub_graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping POST %s/%s", entity_type, entity_id)
        return None
    try:
        timeout = 60 if files else 10
        async with httpx.AsyncClient(timeout=timeout) as client:
            if files:
                resp = await client.post(url, headers=_auth_headers(), files=files)
            else:
                resp = await client.post(url, json=payload, headers=_auth_headers())
            if resp.status_code == 200:
                return resp.json().get("data") or {}
            logger.warning("[hub] POST %s returned %s: %s", url, resp.status_code, resp.text[:200])
            return None
    except Exception as e:
        logger.warning("[hub] POST %s error (non-fatal): %s", url, e)
        return None


async def hub_put(
    entity_type: "BuiltinEntityType",
    entity_id: str,
    payload: dict[str, Any],
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """PUT to a hub entity endpoint (update). Returns the response `data` dict on success, None on failure."""
    url = hub_graph_url(entity_type, entity_id, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping PUT %s/%s", entity_type, entity_id)
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.put(url, json=payload, headers=_auth_headers())
            if resp.status_code == 200:
                return resp.json().get("data") or {}
            logger.warning("[hub] PUT %s returned %s: %s", url, resp.status_code, resp.text[:200])
            return None
    except Exception as e:
        logger.warning("[hub] PUT %s error (non-fatal): %s", url, e)
        return None


