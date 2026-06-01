"""Utilities for communicating with the Flowpad Hub (flowpad.ai cloud).

Provides a thin async HTTP client for making authenticated requests to the
hub's graph API. All hub calls should go through these helpers so the base
URL and auth header are managed in one place.

URL structure follows the Flowpad Hub API guidelines:
  /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}]
"""

from __future__ import annotations

import logging
import uuid as _uuid
from typing import Any, Awaitable, Callable, Optional

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


# An async progress callback: ``await on_progress(bytes_done, bytes_total)``.
# bytes_total is 0 when the size is unknown (no Content-Length on a download).
ProgressCallback = Callable[[int, int], Awaitable[None]]


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
    on_progress: ProgressCallback | None = None,
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
        on_progress: Optional async callback fired as bytes land — requires raw=True.
                     When set the body is streamed (not buffered whole) and the
                     callback receives (bytes_done, bytes_total); bytes_total is 0
                     when the hub sends no Content-Length. Throttled to ~1% steps.
    """
    url = hub_graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping GET %s/%s", entity_type, entity_id)
        return None
    timeout = httpx.Timeout(connect=10, write=10, read=600, pool=5) if raw else httpx.Timeout(10)
    if raw and on_progress is not None:
        try:
            async with FlowpadClient(ApiConfig.from_env()) as client:
                logger.info("[hub] GET (stream) %s", url)
                stream_cm = await client.open_stream("GET", url, params=params or {}, timeout=timeout)
                async with stream_cm as resp:
                    if resp.status_code != 200:
                        logger.warning("[hub] GET %s returned %s", url, resp.status_code)
                        return None
                    total = int(resp.headers.get("Content-Length") or 0)
                    buf = bytearray()
                    reported = 0
                    async for chunk in resp.aiter_bytes():
                        buf.extend(chunk)
                        done = len(buf)
                        step = max(total // 100, 256 * 1024) if total else 256 * 1024
                        if done - reported >= step or (total and done >= total):
                            reported = done
                            try:
                                await on_progress(done, total)
                            except Exception:  # noqa: BLE001
                                pass
                    if reported != len(buf):
                        try:
                            await on_progress(len(buf), total or len(buf))
                        except Exception:  # noqa: BLE001
                            pass
                    return bytes(buf)
        except Exception as e:  # noqa: BLE001
            logger.warning("[hub] GET (stream) %s error (non-fatal): %s", url, e)
            return None
    try:
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
    on_progress: ProgressCallback | None = None,
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
                     Shape: ``{field: (filename, bytes, content_type)}`` — single field.
        on_progress: Optional async callback fired as upload bytes go out —
                     requires files. When set the multipart envelope is hand-built
                     and streamed so the callback receives (bytes_done, bytes_total)
                     between chunks. Throttled to ~1% steps.
    """
    url = hub_graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping POST %s/%s", entity_type, entity_id)
        return None
    timeout = httpx.Timeout(connect=10, write=600, read=60, pool=5) if files else httpx.Timeout(10)
    if files and on_progress is not None:
        return await _hub_post_streamed_upload(url, files, timeout, on_progress)
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


async def _hub_post_streamed_upload(
    url: str,
    files: dict,
    timeout: httpx.Timeout,
    on_progress: ProgressCallback,
) -> Optional[dict[str, Any]]:
    """Hand-build a single-field multipart body and stream it to ``url``.

    httpx's ``files=`` buffers the whole body before sending, so it can't
    report progress. We build the ``multipart/form-data`` envelope ourselves
    and yield it in chunks, firing ``on_progress`` between chunks — that is how
    the body-bundle upload drives the sender's progress bar.
    """
    field, spec = next(iter(files.items()))
    fname, content, ctype = spec
    boundary = _uuid.uuid4().hex
    preamble = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{fname}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode()
    epilogue = f"\r\n--{boundary}--\r\n".encode()
    total = len(preamble) + len(content) + len(epilogue)
    chunk_size = 256 * 1024
    step = max(len(content) // 100, chunk_size)

    async def _body():
        yield preamble
        mv = memoryview(content)
        sent = 0
        reported = 0
        while sent < len(content):
            piece = bytes(mv[sent:sent + chunk_size])
            sent += len(piece)
            yield piece
            if sent - reported >= step or sent >= len(content):
                reported = sent
                try:
                    await on_progress(len(preamble) + sent, total)
                except Exception:  # noqa: BLE001
                    pass
        yield epilogue
        try:
            await on_progress(total, total)
        except Exception:  # noqa: BLE001
            pass

    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(total),
    }
    try:
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info("[hub] POST (stream) %s body=%dB", url, total)
            resp = await client.request(
                "POST", url, content=_body(), headers=headers, timeout=timeout,
            )
    except HubAuthExpiredError as e:
        logger.warning("[hub] POST (stream) %s auth expired: %s", url, e)
        raise HubError(401, "auth expired")
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] POST (stream) %s transport error: %s", url, e)
        raise HubError(0, str(e))
    if resp.status_code == 200:
        return resp.json().get("data") or {}
    reason = _extract_reason(resp)
    logger.warning("[hub] POST (stream) %s returned %s: %s", url, resp.status_code, resp.text[:200])
    raise HubError(resp.status_code, reason)


async def hub_delete(
    entity_type: BuiltinEntityType,
    entity_id: str,
    action: str | None = None,
    *,
    payload: dict[str, Any] | None = None,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """DELETE a hub graph endpoint (entity-level or entity-action).

    ``payload`` is sent as the JSON request body — the hub parses DELETE
    bodies (e.g. ``members`` DELETE expects a ``MembershipMethod``
    ``{member_through, value}``). Returns the response ``data`` dict on
    success, None when FLOWPAD_HUB_URL is not configured. Raises ``HubError``
    on transport failure or non-200 so callers can classify (e.g. 403
    owner-only) vs network errors.
    """
    url = hub_graph_url(entity_type, entity_id, action, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping DELETE %s/%s",
                     entity_type, entity_id)
        return None
    try:
        async with FlowpadClient(ApiConfig.from_env()) as client:
            logger.info("[hub] DELETE %s payload=%s", url, payload)
            resp = await client.request(
                "DELETE", url, json=payload or {}, timeout=httpx.Timeout(10),
            )
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

