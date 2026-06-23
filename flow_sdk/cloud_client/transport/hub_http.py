"""Outbound HTTP to the Flowpad Hub graph API.

Used by backend logic that builds a hub request from semantic args (entity type /
id / action) — the *outbound* counterpart to ``CloudProxy`` (which forwards an
incoming Starlette request). All calls go through one hooked ``FlowpadClient`` so
base URL + bearer injection + error reporting are managed in one place.

The typed ``hub_get`` / ``hub_post`` / ``hub_delete`` / ``hub_put`` helpers each
carry their verb explicitly — never inferred — so a caller can't accidentally send
the wrong method (the same principle that makes ``CloudProxy`` immune to the
GET-reflected-as-DELETE bug).

URL structure follows the Flowpad Hub API guidelines:
  /api/v1/graph/[{scope_type}/{scope_id}/...]{entity_type}[/{entity_id}][/{action}]
"""
from __future__ import annotations

import contextlib as _contextlib
import logging
import uuid as _uuid
from typing import Any, Awaitable, Callable, Optional

import httpx

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.client_hooks import HubAuthExpiredError
from flow_sdk.cloud_client.shared.errors import HubError, _extract_reason
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)


# Process-shared hub client. Every hub call used to do
# ``async with FlowpadClient(ApiConfig.from_env())`` — a fresh client (and thus
# a fresh httpx client + a freshly-built TLS context) per call. Building that
# context reloads the CA bundle from disk (``ssl.load_verify_locations``), which
# profiling showed was ~40% of a conversation-list request (219 hub calls → 219
# cert-bundle loads). Reusing ONE client builds the TLS context once and pools
# connections; httpx clients are safe for concurrent use, and per-request auth
# is injected by the client's event hooks, so the shared instance needs no
# per-call credential refresh. Rebuilt only when the hub base URL changes (read
# back off the client itself, so there's no second bookkeeping global to sync).
_shared_client: "FlowpadClient | None" = None


@_contextlib.asynccontextmanager
async def _hub_client():
    """Yield the process-shared hub client. Does NOT close it on exit (the whole
    point is to keep the TLS context + connection pool alive across calls)."""
    global _shared_client
    cfg = ApiConfig.from_env()
    if _shared_client is None or _shared_client.config.api_base_url != cfg.api_base_url:
        await close_hub_client()  # close any stale (URL-changed) client first
        _shared_client = FlowpadClient(cfg)
    yield _shared_client


async def close_hub_client() -> None:
    """Close the shared hub client (call on server shutdown)."""
    global _shared_client
    if _shared_client is not None:
        client, _shared_client = _shared_client, None
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass


# An async progress callback: ``await on_progress(bytes_done, bytes_total)``.
# bytes_total is 0 when the size is unknown (no Content-Length on a download).
ProgressCallback = Callable[[int, int], Awaitable[None]]


def hub_base_url() -> Optional[str]:
    """Return the hub base URL from config, or None if not configured.

    In Local (private) data-privacy mode this always returns ``None`` so every
    outbound hub call short-circuits exactly as it does when ``FLOWPAD_HUB_URL``
    is unset — the single chokepoint that guarantees no HTTP reaches the cloud.
    """
    from flow_sdk.instance_settings.privacy_mode import is_local_mode
    if is_local_mode():
        return None
    from flow_sdk.config import default_service_config
    url = default_service_config.flowpad_hub_url
    return url.rstrip("/") if url else None


async def get_info() -> Optional[dict[str, Any]]:
    """Fetch lightweight info about the configured hub.

    Currently returns the hub's running version and optional build metadata::

        {"version": "0.29.41", "deployed_at": "...", "generated_at": "..."}

    Hits the public ``GET /api/v1/health/version`` endpoint (no auth), so it
    works even when the user is signed out. Returns ``None`` when the hub is
    not configured (``FLOWPAD_HUB_URL`` unset) or unreachable.
    """
    base = hub_base_url()
    if not base:
        return None
    from flow_sdk.api.api_request import APIRequest
    url = f"{base}{APIRequest.api_prefix}/health/version"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=httpx.Timeout(8))
            if resp.status_code != 200:
                logger.warning("[hub] GET %s returned %s", url, resp.status_code)
                return None
            # The hub wraps responses in an ApiResponse envelope. Older hubs
            # returned the version string directly; newer hubs return an object
            # with build timestamps.
            data = resp.json().get("data")
            if isinstance(data, str):
                return {"version": data}
            if isinstance(data, dict):
                version = data.get("version")
                deployed_at = data.get("deployed_at")
                generated_at = data.get("generated_at")
                # Fixed community/support project id — the app opens support
                # tickets against this project. Returned by newer hubs only.
                community_project_id = data.get("community_project_id")
                return {
                    "version": version if isinstance(version, str) else None,
                    "deployed_at": deployed_at if isinstance(deployed_at, str) else None,
                    "generated_at": generated_at if isinstance(generated_at, str) else None,
                    "community_project_id": (
                        community_project_id if isinstance(community_project_id, str) else None
                    ),
                }
            return {"version": None}
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] get_info error (non-fatal): %s", e)
        return None


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
            async with _hub_client() as client:
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
        async with _hub_client() as client:
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


# Result of a status-aware hub existence probe (see ``hub_resolve_by_typeid``):
#   "present"       — the hub returned 200; the entity exists there.
#   "absent"        — the hub returned a definitive 404; the entity is gone.
#   "indeterminate" — hub not configured / unreachable / 5xx / non-hub type.
#                     We do NOT know, so callers must treat this as "not gone"
#                     (never destructively clean on an indeterminate result).
HubResolveState = str  # Literal["present", "absent", "indeterminate"]


async def hub_resolve_by_typeid(typeid: Any) -> tuple[HubResolveState, Optional[dict[str, Any]]]:
    """Status-aware existence probe for an entity by TypeId against the hub.

    Unlike ``hub_get`` (which collapses every non-200 — including a definitive
    404 and a transient network failure — to ``None``), this distinguishes the
    three cases callers need to make a *safe* cleanup decision:

      * ``("present", data)``   — hub has it (200).
      * ``("absent", None)``    — hub definitively does not (404).
      * ``("indeterminate", None)`` — unknown: hub unset, unreachable, 5xx, or
        a type the hub doesn't serve. Callers MUST treat this as "not gone".

    The id-resolution / reconcile paths depend on this: "hub is down" must never
    be mistaken for "the entity was deleted".
    """
    # Map the typeid's type string → BuiltinEntityType (StrEnum, keyed by value).
    # A type the hub registry doesn't know is not hub-resolvable → indeterminate.
    try:
        entity_type = BuiltinEntityType(typeid.type)
    except ValueError:
        return ("indeterminate", None)

    url = hub_graph_url(entity_type, typeid.id)
    if not url:
        # FLOWPAD_HUB_URL not configured — we genuinely don't know.
        return ("indeterminate", None)
    try:
        async with _hub_client() as client:
            resp = await client.request("GET", url, params={}, timeout=httpx.Timeout(10))
            if resp.status_code == 200:
                return ("present", resp.json().get("data") or {})
            if resp.status_code == 404:
                return ("absent", None)
            logger.warning("[hub] resolve %s returned %s — indeterminate", url, resp.status_code)
            return ("indeterminate", None)
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] resolve %s error (non-fatal, indeterminate): %s", url, e)
        return ("indeterminate", None)


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
        async with _hub_client() as client:
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
        async with _hub_client() as client:
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
        async with _hub_client() as client:
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
    action: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """PUT to a hub entity endpoint (update), or to an entity-action endpoint
    when ``action`` is given (e.g. ``members`` role change → PUT
    ``/<type>/<id>/members``). Returns the response `data` dict on success.

    Returns None only when FLOWPAD_HUB_URL is not configured (offline mode).
    Raises HubError on transport failure or non-200 response.
    """
    url = hub_graph_url(entity_type, entity_id, action, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping PUT %s/%s", entity_type, entity_id)
        return None
    try:
        async with _hub_client() as client:
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
