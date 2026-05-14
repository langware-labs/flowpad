"""Utilities for communicating with the Flowpad Hub (flowpad.ai cloud).

Provides a thin async HTTP client for making authenticated requests to the
hub's graph API. All hub calls should go through these helpers so the base
URL and auth header are managed in one place.

URL structure follows the Flowpad Hub API guidelines:
  /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}]
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.client_hooks import HubAuthExpiredError
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)


class HubError(Exception):
    """Raised when a hub HTTP call fails (transport error or non-2xx response).

    `status_code` is 0 for transport errors (DNS, timeout, refused, etc.).
    `reason` is a short human-readable string suitable for surfacing to end users.
    """

    def __init__(self, status_code: int, reason: str):
        self.status_code = status_code
        self.reason = reason
        super().__init__(f"hub error {status_code}: {reason}")


def _extract_reason(resp: httpx.Response) -> str:
    """Pull a short failure reason out of an httpx response body.

    Tries JSON `message` / `detail` / `error` first (the shapes flowpad-hub
    and FastAPI use), then falls back to the raw text trimmed to 300 chars.
    """
    try:
        body = resp.json()
        if isinstance(body, dict):
            for key in ("message", "detail", "error"):
                val = body.get(key)
                if val:
                    return str(val)
    except Exception:
        pass
    text = (resp.text or "").strip()
    if text:
        return text[:300]
    return f"HTTP {resp.status_code}"


def hub_base_url() -> Optional[str]:
    """Return the hub base URL from config, or None if not configured."""
    from flow_sdk.config import default_service_config
    url = default_service_config.flowpad_hub_url
    return url.rstrip("/") if url else None


def hub_graph_url(
    entity_type: BuiltinEntityType,
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


async def hub_get(
    entity_type: BuiltinEntityType,
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
        timeout = httpx.Timeout(connect=10, write=10, read=600, pool=5) if raw else httpx.Timeout(10)
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info("[hub] GET %s params=%s", url, params)
            resp = await client.request("GET", url, params=params or {}, timeout=timeout)
            if resp.status_code == 200:
                result = resp.content if raw else resp.json().get("data") or {}
                return result
            logger.warning("[hub] GET %s returned %s: %s", url, resp.status_code, resp.text[:500])
            return None
    except Exception as e:
        logger.warning("[hub] GET %s error (non-fatal): %s", url, e)
        return None


async def hub_post(
    entity_type: BuiltinEntityType,
    payload: dict[str, Any],
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
    files: dict | None = None,
) -> Optional[dict[str, Any]]:
    """POST to a hub graph endpoint. Returns the response `data` dict on success.

    Returns None only when FLOWPAD_HUB_URL is not configured (offline mode).
    Raises HubError on transport failure or non-200 response — callers that
    want to suppress hub failures must catch HubError themselves.

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
    timeout = httpx.Timeout(connect=10, write=600, read=60, pool=5) if files else httpx.Timeout(10)
    try:
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info(
                "[hub] POST %s files=%s payload_keys=%s",
                url, bool(files), list(payload.keys()) if not files and payload else None,
            )
            if files:
                resp = await client.request("POST", url, files=files, timeout=timeout)
            else:
                resp = await client.request("POST", url, json=payload, timeout=timeout)
    except HubAuthExpiredError as e:
        logger.warning("[hub] POST %s auth expired: %s", url, e)
        raise HubError(401, "auth expired")
    except Exception as e:
        logger.warning("[hub] POST %s transport error: %s", url, e)
        raise HubError(0, str(e))
    if resp.status_code == 200:
        return resp.json().get("data") or {}
    reason = _extract_reason(resp)
    logger.warning("[hub] POST %s returned %s: %s", url, resp.status_code, resp.text[:200])
    raise HubError(resp.status_code, reason)


async def hub_delete(
    entity_type: BuiltinEntityType,
    entity_id: str,
    action: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """DELETE a hub graph endpoint (entity-level or entity-action).

    Returns the response ``data`` dict on success, None when FLOWPAD_HUB_URL
    is not configured. Raises ``HubError`` on transport failure or non-200
    so callers can classify (e.g. 403 owner-only) vs network errors.
    """
    url = hub_graph_url(entity_type, entity_id, action, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping DELETE %s/%s",
                     entity_type, entity_id)
        return None
    try:
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info("[hub] DELETE %s", url)
            resp = await client.request("DELETE", url, timeout=httpx.Timeout(10))
    except HubAuthExpiredError as e:
        logger.warning("[hub] DELETE %s auth expired: %s", url, e)
        raise HubError(401, "auth expired")
    except Exception as e:
        logger.warning("[hub] DELETE %s transport error: %s", url, e)
        raise HubError(0, str(e))
    if resp.status_code == 200:
        return resp.json().get("data") or {}
    reason = _extract_reason(resp)
    logger.warning("[hub] DELETE %s returned %s: %s", url, resp.status_code, resp.text[:200])
    raise HubError(resp.status_code, reason)


async def hub_put(
    entity_type: BuiltinEntityType,
    entity_id: str,
    payload: dict[str, Any],
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """PUT to a hub entity endpoint (update). Returns the response `data` dict on success.

    Returns None only when FLOWPAD_HUB_URL is not configured (offline mode).
    Raises HubError on transport failure or non-200 response.
    """
    url = hub_graph_url(entity_type, entity_id, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping PUT %s/%s", entity_type, entity_id)
        return None
    try:
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info(
                "[hub] PUT %s payload_keys=%s",
                url, list(payload.keys()) if payload else None,
            )
            resp = await client.request("PUT", url, json=payload, timeout=10)
    except HubAuthExpiredError as e:
        logger.warning("[hub] PUT %s auth expired: %s", url, e)
        raise HubError(401, "auth expired")
    except Exception as e:
        logger.warning("[hub] PUT %s transport error: %s", url, e)
        raise HubError(0, str(e))
    if resp.status_code == 200:
        return resp.json().get("data") or {}
    reason = _extract_reason(resp)
    logger.warning("[hub] PUT %s returned %s: %s", url, resp.status_code, resp.text[:200])
    raise HubError(resp.status_code, reason)

