"""HubProxy — the one way this machine talks HTTP to the Flowpad Hub.

Every hub request leaves through ``HubProxy.send``: one shared hooked client (bearer +
machine id injected by ``client_hooks``), one reachability record (``_note_reach``), one
failure classification (``HubError``). Three shapes are built on it:

- ``forward(request)``     — an incoming Starlette request, verbatim: same method, raw path,
                             query, headers (minus hop-by-hop / Host / Authorization /
                             Hub-Reflect) and body; the hub's status, headers and body stream
                             back untouched. The desktop graph path IS the hub's graph path.
- ``forward_buffered(...)`` — the same, for a caller that has no Starlette request or needs
                             the whole answer (WS ``rest_api_msg``, the post-proxy mirror).
- ``call(...)``            — a hub graph call built from (type, id, action, sub_path); answers
                             the envelope's ``data`` or raises ``HubError``. The typed
                             ``hub_http`` helpers are thin wrappers over it.

The proxy never rewrites a request body or a response; deciding WHETHER a call goes to the
hub is ``server/routes/_hub_reflect.py``'s job, not this module's.
"""

from __future__ import annotations

import logging
import uuid as _uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping, Optional

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from flow_sdk.cloud_client.client_hooks import ANONYMOUS_EXTENSION, PASSTHROUGH_EXTENSION, HubAuthExpiredError
from flow_sdk.cloud_client.shared.errors import HubError, _extract_error_code, _extract_reason, classify_hub_failure
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind

if TYPE_CHECKING:
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

logger = logging.getLogger(__name__)

# An async progress callback: ``await on_progress(bytes_done, bytes_total)``.
# bytes_total is 0 when the size is unknown (no Content-Length on a download).
ProgressCallback = Callable[[int, int], Awaitable[None]]

# Result of a status-aware hub existence probe (``HubProxy.resolve_by_typeid``):
#   "present"       — the hub returned 200; the entity exists there.
#   "absent"        — the hub returned a definitive 404; the entity is gone.
#   "indeterminate" — hub not configured / unreachable / 5xx / non-hub type.
#                     We do NOT know, so callers must treat this as "not gone".
HubResolveState = str  # Literal["present", "absent", "indeterminate"]

# RFC 7230 §6.1 hop-by-hop headers — never forwarded end-to-end, either direction.
HOP_BY_HOP: frozenset[bytes] = frozenset(
    {
        b"connection",
        b"keep-alive",
        b"proxy-authenticate",
        b"proxy-authorization",
        b"te",
        b"trailer",
        b"trailers",
        b"transfer-encoding",
        b"upgrade",
        b"proxy-connection",
    }
)
# Outbound we also drop Host (httpx sets the hub's authority), any stale Authorization (the
# client hook injects the live credential) and Hub-Reflect (a local routing directive).
# Content-Length is kept: a streamed upload goes out with its declared length, not chunked.
# ``cookie`` / ``set-cookie``: this machine's session cookies never leave it, and the hub's
# never land on the local origin -- the hub call is authenticated by the bearer alone.
DROP_OUTBOUND: frozenset[bytes] = HOP_BY_HOP | {b"host", b"authorization", b"hub-reflect", b"cookie"}
DROP_INBOUND: frozenset[bytes] = HOP_BY_HOP | {b"set-cookie"}
# The only hub surface a forwarded request may reach.
FORWARDABLE_PREFIX = "/api/v1/graph/"

DEFAULT_TIMEOUT = httpx.Timeout(10)
# A forwarded request may be an upload or a download of any size, or a stream that stays open.
FORWARD_TIMEOUT = httpx.Timeout(connect=10, write=600, read=600, pool=10)


@dataclass
class HubAnswer:
    """A buffered hub response: status, headers and the raw body, nothing interpreted."""

    status_code: int
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)
    content: bytes = b""

    @property
    def content_type(self) -> str:
        for k, v in self.headers:
            if k.lower() == b"content-type":
                return v.decode("latin-1")
        return ""

    def json(self) -> Any:
        import json  # noqa: PLC0415

        return json.loads(self.content) if self.content else None


def graph_url(
    entity_type: Any,
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> str | None:
    """The hub graph URL for these segments (``hub_http.hub_graph_url``), None when no hub."""
    from flow_sdk.cloud_client.transport.hub_http import hub_graph_url  # noqa: PLC0415

    return hub_graph_url(entity_type, entity_id, action, sub_path, scope=scope)


def _note_reach(status_code: int) -> None:
    from flow_sdk.cloud_client.transport import hub_http  # noqa: PLC0415

    hub_http._note_reach(status_code)


class HubProxy:
    """Stateless; the connection pool lives in ``hub_http._hub_client``."""

    # ── the single I/O path ──────────────────────────────────────────────────────────

    @staticmethod
    async def send(
        method: str,
        url: str | httpx.URL,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        content: Any = None,
        files: Any = None,
        headers: Any = None,
        timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
        anonymous: bool = False,
        passthrough: bool = False,
        stream: bool = False,
    ) -> httpx.Response:
        """Send ONE request to the hub and return the response, whatever its status.

        Raises ``HubError`` only when nothing came back: 401 ``signed_out`` for an expired
        login, 0 ``offline`` for a transport failure. ``stream=True`` returns an open
        response; the caller must ``aclose()`` it. ``passthrough`` keeps the client hooks
        off the body (a streamed answer must not be read by a hook).
        """
        from flow_sdk.cloud_client.transport.hub_http import _hub_client  # noqa: PLC0415

        extensions: dict[str, Any] = {}
        if anonymous:
            extensions[ANONYMOUS_EXTENSION] = True
        if passthrough or stream:
            extensions[PASSTHROUGH_EXTENSION] = True
        try:
            async with _hub_client() as fp:
                client = await fp._get_client()
                request = client.build_request(
                    method.upper(),
                    url,
                    params=dict(params) if params else None,
                    json=json if (content is None and files is None) else None,
                    content=content,
                    files=files,
                    headers=headers,
                    timeout=timeout,
                    extensions=extensions or None,
                )
                logger.info("[hub] %s %s", request.method, request.url)
                resp = await client.send(request, stream=stream)
        except HubAuthExpiredError as e:
            logger.warning("[hub] %s %s auth expired: %s", method, url, e)
            raise HubError(401, "auth expired", kind=HubFailureKind.SIGNED_OUT) from e
        except HubError:
            raise
        except Exception as e:  # noqa: BLE001 — any transport failure is "offline"
            logger.warning("[hub] %s %s transport error: %s", method, url, e)
            _note_reach(0)
            raise HubError(0, str(e) or type(e).__name__) from e
        _note_reach(resp.status_code)
        return resp

    # ── graph calls from semantic args ───────────────────────────────────────────────

    @classmethod
    async def call(
        cls,
        method: str,
        entity_type: Any,
        entity_id: str | None = None,
        action: str | None = None,
        sub_path: str | None = None,
        *,
        scope: list[tuple[str, str]] | None = None,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        files: Any = None,
        timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
        strict: bool = False,
        anonymous: bool = False,
        raw: bool = False,
    ) -> Any:
        """Call a hub graph endpoint and answer its envelope's ``data`` (``{}`` when empty).

        Raises ``HubError``: ``not_configured`` with no hub, the hub's status on any non-200,
        ``server_error`` on a 200 that is not JSON, and with ``strict`` a 200 envelope that
        says FAIL. ``raw`` answers the body's bytes.
        """
        url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
        if not url:
            raise HubError(0, "no hub configured", kind=HubFailureKind.NOT_CONFIGURED)
        return await cls.call_url(
            method, url, params=params, json=json, files=files, timeout=timeout, strict=strict,
            anonymous=anonymous, raw=raw,
        )  # fmt: skip

    @classmethod
    async def call_url(
        cls,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any = None,
        files: Any = None,
        content: Any = None,
        headers: Any = None,
        timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
        strict: bool = False,
        anonymous: bool = False,
        raw: bool = False,
    ) -> Any:
        """``call`` for a URL already built (``hub_graph_url`` / ``hub_public_url``)."""
        resp = await cls.send(
            method, url, params=params, json=json, files=files, content=content, headers=headers,
            timeout=timeout, anonymous=anonymous,
        )  # fmt: skip
        return unwrap(resp, method=method, url=url, strict=strict, raw=raw)

    # ── verbatim forwarding ──────────────────────────────────────────────────────────

    @staticmethod
    def target_url(raw_path: bytes | str, query: bytes | str = b"") -> httpx.URL:
        """The hub URL for a local raw path + query: the base URL swapped, nothing else."""
        from flow_sdk.cloud_client.transport.hub_http import hub_base_url  # noqa: PLC0415

        base = hub_base_url()
        if not base:
            raise HubError(0, "hub not configured (FLOWPAD_HUB_URL unset)", kind=HubFailureKind.NOT_CONFIGURED)
        path = raw_path.encode("latin-1") if isinstance(raw_path, str) else raw_path
        qs = query.encode("latin-1") if isinstance(query, str) else (query or b"")
        full = path + (b"?" + qs if qs else b"")
        try:
            return httpx.URL(base).copy_with(raw_path=full)
        except Exception:  # noqa: BLE001 — a base with its own path prefix
            return httpx.URL(str(base).rstrip("/") + full.decode("latin-1"))

    @staticmethod
    def outbound_headers(raw_headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
        return [(k, v) for (k, v) in raw_headers if k.lower() not in DROP_OUTBOUND]

    @staticmethod
    def inbound_headers(raw_headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
        return [(k, v) for (k, v) in raw_headers if k.lower() not in DROP_INBOUND]

    @staticmethod
    def contained(target: httpx.URL) -> httpx.URL:
        """``target`` when it is a hub graph path; ``HubError(400)`` for anything else, or a dot segment."""
        from urllib.parse import unquote  # noqa: PLC0415

        from flow_sdk.cloud_client.transport.hub_http import hub_base_url  # noqa: PLC0415

        prefix = httpx.URL(hub_base_url() or "/").path.rstrip("/") + FORWARDABLE_PREFIX
        raw = target.raw_path.split(b"?", 1)[0].decode("latin-1")
        decoded = unquote(unquote(raw))  # once more for a double-encoded dot or slash
        segments = decoded.replace("\\", "/").split("/")
        if not decoded.startswith(prefix) or any(seg in (".", "..") for seg in segments):
            raise HubError(400, f"not a hub graph path: {raw[:120]}")
        return target

    @staticmethod
    async def _request_body(request: Request) -> Any:
        """The body to forward: streamed when the client declared one, else whatever the
        request holds (a WS ``rest_api_msg`` request has a body but no Content-Length)."""
        clen = request.headers.get("content-length")
        te = (request.headers.get("transfer-encoding") or "").lower()
        if (clen not in (None, "0")) or ("chunked" in te):
            return request.stream()
        body = await request.body()
        return body or None

    @classmethod
    async def open(
        cls,
        request: Request,
        url: str | httpx.URL | None = None,
        *,
        content: bytes | None = None,
    ) -> httpx.Response:
        """Send an incoming request to the hub and return the OPEN response (caller closes it).

        ``url`` overrides the target (an endpoint whose hub path differs from the local one);
        by default the local raw path + query are used byte for byte. ``content`` replaces the
        body (its Content-Length is recomputed). Raises ``HubError`` when nothing came back.
        """
        target = (
            httpx.URL(url)
            if url is not None
            else cls.target_url(
                request.scope.get("raw_path") or request.url.path.encode(),
                request.scope.get("query_string") or b"",
            )
        )
        target = cls.contained(target)
        headers = cls.outbound_headers(list(request.headers.raw))
        if content is not None:
            headers = [(k, v) for (k, v) in headers if k.lower() != b"content-length"]
        return await cls.send(
            request.method,
            target,
            content=content if content is not None else await cls._request_body(request),
            headers=headers,
            timeout=FORWARD_TIMEOUT,
            stream=True,
        )

    @classmethod
    def relay(cls, resp: httpx.Response) -> StreamingResponse:
        """Stream an open hub response back verbatim; it is closed when the stream ends (also on a hang-up)."""
        if resp.is_stream_consumed:
            # The auth hook read this one (a forwarded 401): send the decoded copy it holds.
            drop = {b"content-length", b"content-encoding", b"transfer-encoding"}
            out = Response(resp.content, status_code=resp.status_code)
            out.raw_headers = [h for h in cls.inbound_headers(list(resp.headers.raw)) if h[0].lower() not in drop]
            out.raw_headers.append((b"content-length", str(len(resp.content)).encode()))
            return out
        out = StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, background=BackgroundTask(resp.aclose))
        out.raw_headers = cls.inbound_headers(list(resp.headers.raw))  # dup Set-Cookie, exact CL/CE/CT
        return out

    @staticmethod
    def failure(e: HubError) -> Response:
        """The answer for a request that got no hub response: the standard FAIL envelope."""
        import json  # noqa: PLC0415

        status = e.status_code if e.status_code >= 400 else (503 if e.kind is HubFailureKind.NOT_CONFIGURED else 502)
        body = {"status": "FAIL", "message": e.reason or "hub unreachable", "data": {"hub_failure": str(e.kind)}}
        return Response(json.dumps(body).encode(), status_code=status, media_type="application/json")

    @classmethod
    async def forward(cls, request: Request, url: str | httpx.URL | None = None) -> Response:
        """Forward an incoming request to the hub and stream the hub's answer back verbatim.

        No hub answer → ``failure`` (502 offline, 401 signed out, 503 not configured); the
        hub's own refusals arrive exactly as the hub sent them.
        """
        try:
            resp = await cls.open(request, url)
        except HubError as e:
            return cls.failure(e)
        return cls.relay(resp)

    @classmethod
    async def forward_buffered(
        cls,
        method: str,
        raw_path: bytes | str,
        query: bytes | str = b"",
        *,
        headers: list[tuple[bytes, bytes]] | None = None,
        content: bytes | None = None,
    ) -> HubAnswer:
        """``forward`` for a caller that needs the whole answer in hand. Raises ``HubError``
        only when nothing came back (offline / signed out / no hub)."""
        resp = await cls.send(
            method,
            cls.contained(cls.target_url(raw_path, query)),
            content=content or None,
            headers=cls.outbound_headers(headers or []),
            timeout=FORWARD_TIMEOUT,
            passthrough=True,
        )
        # ``resp.content`` is the decoded body; the encoding headers no longer describe it.
        hdrs = [
            (k, v)
            for (k, v) in cls.inbound_headers(list(resp.headers.raw))
            if k.lower() not in (b"content-encoding", b"content-length")
        ]
        return HubAnswer(resp.status_code, hdrs, resp.content)


def unwrap(resp: httpx.Response, *, method: str = "", url: Any = "", strict: bool = False, raw: bool = False) -> Any:
    """A hub response read as a graph-call answer: ``data`` on 200, ``HubError`` otherwise."""
    if resp.status_code != 200:
        logger.warning("[hub] %s %s returned %s: %s", method, url, resp.status_code, resp.text[:200])
        raise HubError(resp.status_code, _extract_reason(resp), code=_extract_error_code(resp))
    if raw:
        return resp.content
    try:
        body = resp.json()
    except ValueError as e:
        raise HubError(200, "HTTP 200 with a body that is not JSON", kind=HubFailureKind.SERVER_ERROR) from e
    if not isinstance(body, dict):
        return {}
    if strict and str(body.get("status") or "").upper() == "FAIL":
        code = _extract_error_code(resp)
        raise HubError(
            200, str(body.get("message") or "the hub refused"), code=code, kind=classify_hub_failure(400, code)
        )
    return body.get("data") or {}


# ── typed graph calls: the call-site API (``HubProxy.get`` / ``post`` / ``put`` / …) ─────────
# Each keeps the exact contract its ``hub_*`` predecessor had (what answers None, what raises),
# so moving a call site onto it changes nothing but the name.


async def _send(
    method: str,
    url: str,
    *,
    payload: Any = None,
    files: dict | None = None,
    params: dict[str, str] | None = None,
    timeout: httpx.Timeout | float = httpx.Timeout(10),
    strict: bool = False,
    anonymous: bool = False,
    raw: bool = False,
) -> Any:
    """Send ONE hub request and answer its ``data`` — or raise ``HubError`` classified once.

    Every typed helper below goes through here, so a failure is read one way everywhere:
    no answer is ``offline``, a dead credential ``signed_out``, a load balancer's HTML page a
    ``server_error`` that never echoes its body. ``strict`` additionally refuses a 200 whose
    envelope says FAIL (the help paths need that; older callers still take ``{}``).
    ``anonymous`` sends no credential (``ANONYMOUS_EXTENSION``); ``raw`` answers the body's bytes.
    """

    return await HubProxy.call_url(
        method, url, params=params, json=None if files else payload, files=files, timeout=timeout,
        strict=strict, anonymous=anonymous, raw=raw,
    )  # fmt: skip


async def _request(
    method: str,
    entity_type: BuiltinEntityType | str,
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    payload: Any = None,
    files: dict | None = None,
    params: dict[str, str] | None = None,
    scope: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """The hub call that never answers None: every way it can fail raises a classified ``HubError``.

    Unlike ``hub_post`` (None when no hub is configured), this raises ``not_configured``; with
    no credential it raises ``signed_out`` before anything is sent.
    """
    from flow_sdk.cloud_client.client_hooks import resolve_hub_credential  # noqa: PLC0415

    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        raise HubError(0, "no hub configured", kind=HubFailureKind.NOT_CONFIGURED)
    try:
        credential = await resolve_hub_credential()
    except HubAuthExpiredError as e:
        raise HubError(401, "auth expired", kind=HubFailureKind.SIGNED_OUT) from e
    if not credential:
        raise HubError(0, "signed out", kind=HubFailureKind.SIGNED_OUT)
    return await _send(method, url, payload=payload, files=files, params=params, strict=True)


async def _anonymous_request(
    method: str,
    entity_type: BuiltinEntityType | str,
    entity_id: str,
    action: str,
    payload: Any = None,
    *,
    raw: bool = False,
) -> Any:
    """One graph call whose ENTITY ID is the credential: ``_send`` with this box's login left out.

    For an entity that admits whoever holds its id (``public_role``: a diagnosis request's
    ``brief``/``submit``). ``raw`` answers the body's bytes (a file) instead of its ``data``.
    """
    url = graph_url(entity_type, entity_id, action)
    if not url:
        raise HubError(0, "no hub configured", kind=HubFailureKind.NOT_CONFIGURED)
    return await _send(method, url, payload=payload, timeout=httpx.Timeout(30), anonymous=True, raw=raw)


async def _get(
    entity_type: BuiltinEntityType | str,
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
    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping GET %s/%s", entity_type, entity_id)
        return None
    timeout = httpx.Timeout(connect=10, write=10, read=600, pool=5) if raw else httpx.Timeout(10)

    if raw and on_progress is not None:
        try:
            resp = await HubProxy.send("GET", url, params=params, timeout=timeout, stream=True)
            try:
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
            finally:
                await resp.aclose()
        except Exception as e:  # noqa: BLE001
            logger.warning("[hub] GET (stream) %s error (non-fatal): %s", url, e)
            return None
    try:
        resp = await HubProxy.send("GET", url, params=params, timeout=timeout)
        if resp.status_code == 200:
            return resp.content if raw else resp.json().get("data") or {}
        logger.warning("[hub] GET %s returned %s: %s", url, resp.status_code, resp.text[:500])
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] GET %s error (non-fatal): %s", url, e)
        return None


async def _get_or_raise(
    entity_type: BuiltinEntityType,
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    """GET a hub graph endpoint, PRESERVING the status. Raises ``HubError``.

    The symmetric sibling of :func:`hub_post`, and the reason it exists is an
    asymmetry that was quietly harmful: ``hub_get`` collapses *hub not
    configured*, *signed out*, *network error*, *5xx* and a **definitive 404**
    all to ``None``. A caller that must decide "is this permanently broken, or
    just unreachable right now?" cannot, and picking either answer for ``None``
    is wrong in one direction — park a healthy source on one dropped packet, or
    retry a deleted resource every cycle forever while the UI shows a spinner
    instead of "fix me".

    That is the same three-way distinction :func:`hub_resolve_by_typeid`
    documents; this returns the status so an ingest driver can map it through
    ``SourceError.for_status`` — THE status→health table — instead of growing a
    second copy of it.

    ``HubError.status_code`` is 0 when there was no HTTP response at all; the
    ``reason`` then separates "no hub URL configured" (a person must act) from a
    transport failure (retry at the ordinary cadence).
    """
    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        raise HubError(0, "hub not configured", kind=HubFailureKind.NOT_CONFIGURED)
    return await _send("GET", url, params=params)


async def _resolve_by_typeid(typeid: Any) -> tuple[HubResolveState, Optional[dict[str, Any]]]:
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
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415 — pulls the db layer

    try:
        entity_type = BuiltinEntityType(typeid.type)
    except ValueError:
        return ("indeterminate", None)

    url = graph_url(entity_type, typeid.id)
    if not url:
        # FLOWPAD_HUB_URL not configured — we genuinely don't know.
        return ("indeterminate", None)

    try:
        resp = await HubProxy.send("GET", url)
        if resp.status_code == 200:
            return ("present", resp.json().get("data") or {})
        if resp.status_code == 404:
            return ("absent", None)
        logger.warning("[hub] resolve %s returned %s — indeterminate", url, resp.status_code)
        return ("indeterminate", None)
    except Exception as e:  # noqa: BLE001
        logger.warning("[hub] resolve %s error (non-fatal, indeterminate): %s", url, e)
        return ("indeterminate", None)


async def _post(
    entity_type: BuiltinEntityType | str,
    payload: dict[str, Any],
    entity_id: str | None = None,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
    files: dict | None = None,
    on_progress: ProgressCallback | None = None,
    params: dict[str, str] | None = None,
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
    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping POST %s/%s", entity_type, entity_id)
        return None
    timeout = httpx.Timeout(connect=10, write=600, read=60, pool=5) if files else httpx.Timeout(10)
    if files and on_progress is not None:
        return await _post_streamed_upload(url, files, timeout, on_progress)
    return await _send("POST", url, payload=None if files else payload, files=files, params=params, timeout=timeout)


async def _invoke_raw(
    entity_type: BuiltinEntityType | str,
    entity_id: str,
    sub_path: str,
    payload: Any,
    *,
    method: str = "POST",
) -> tuple[int, Any]:
    """Call a hub passthrough (``<type>/<id>/invoke/<sub_path>``) and return the UPSTREAM answer.

    ``hub_post`` cannot carry it: an ``invoke`` answers the vendor's own body, not the hub
    envelope, and ``hub_post`` keeps only ``data`` -- a Jev decision came back ``{}``. So this
    returns ``(status, parsed JSON)`` for every status and lets the caller fold it; the hub's
    own refusals (403/429/503 with ``{error, message}``) arrive the same way.

    Same client, auth and Local-privacy gate as every other hub call (``hub_graph_url`` is
    ``None`` in Local mode or offline, and so is the answer: ``(0, None)``).
    Raises ``HubError(0, ...)`` on transport failure and ``HubError(401)`` on an expired login.
    """
    url = graph_url(entity_type, entity_id, "invoke", sub_path)
    if not url:
        return 0, None

    resp = await HubProxy.send(method, url, json=payload)
    try:
        body = resp.json()
    except ValueError:
        body = resp.text[:500]
    return resp.status_code, body


async def _post_streamed_upload(
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
            piece = bytes(mv[sent : sent + chunk_size])
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

    logger.info("[hub] POST (stream) %s body=%dB", url, total)
    resp = await HubProxy.send("POST", url, content=_body(), headers=headers, timeout=timeout)
    if resp.status_code == 200:
        return resp.json().get("data") or {}
    reason = _extract_reason(resp)
    logger.warning("[hub] POST (stream) %s returned %s: %s", url, resp.status_code, resp.text[:200])
    raise HubError(resp.status_code, reason, code=_extract_error_code(resp))


async def _delete(
    entity_type: BuiltinEntityType,
    entity_id: str,
    action: str | None = None,
    sub_path: str | None = None,
    *,
    payload: dict[str, Any] | None = None,
    params: dict[str, str] | None = None,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """DELETE a hub graph endpoint (entity-level or entity-action).

    ``payload`` is sent as the JSON request body — the hub parses DELETE
    bodies (e.g. ``members`` DELETE expects a ``MembershipMethod``
    ``{member_through, value}``). ``sub_path`` selects a sibling endpoint under
    the same action (``members/link``), and ``params`` carries its selector
    (revoke takes ``?link-id=``) — both mirror ``hub_get``/``hub_post``, and
    without the sub-path a ``members/link`` DELETE would reach the hub as a
    member removal. Returns the response ``data`` dict on success, None when
    FLOWPAD_HUB_URL is not configured. Raises ``HubError`` on transport failure
    or non-200 so callers can classify (e.g. 403 owner-only) vs network errors.
    """
    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping DELETE %s/%s", entity_type, entity_id)
        return None
    return await _send("DELETE", url, payload=payload or {}, params=params)


async def _put(
    entity_type: BuiltinEntityType,
    entity_id: str,
    payload: dict[str, Any],
    action: str | None = None,
    sub_path: str | None = None,
    *,
    scope: list[tuple[str, str]] | None = None,
) -> Optional[dict[str, Any]]:
    """PUT to a hub entity endpoint (update), or to an entity-action endpoint
    when ``action`` is given (e.g. ``members`` role change → PUT
    ``/<type>/<id>/members``). Returns the response `data` dict on success.

    Returns None only when FLOWPAD_HUB_URL is not configured (offline mode).
    Raises HubError on transport failure or non-200 response.
    """
    url = graph_url(entity_type, entity_id, action, sub_path, scope=scope)
    if not url:
        logger.debug("[hub] FLOWPAD_HUB_URL not set — skipping PUT %s/%s", entity_type, entity_id)
        return None
    return await _send("PUT", url, payload=payload)


async def _upload_entity_file(
    entity_type: BuiltinEntityType,
    entity_id: str,
    filename: str,
    content: bytes,
    sub_path: str = "upload",
) -> None:
    """Upload ONE file into an entity's hub VFS.

    The single call behind both halves of entity-file write-through: the
    per-upload mirror in ``_hub_reflect._reflect_fs_to_hub`` (a shared entity's
    live writes) and the catch-up in ``Entity.share()`` (files that already
    existed when the hub twin was created — they can't ride the create POST,
    which is JSON, and ``fs/upload`` needs the id to exist first).

    ``sub_path`` is the destination DIRECTORY, not the target name — the hub
    takes the filename from the multipart part. Passing ``upload/<name>`` would
    nest it as ``<name>/<name>``.
    """
    await HubProxy.post(
        entity_type,
        {},
        entity_id,
        "fs",
        sub_path,
        files={"uploaded_file": (filename, content, "application/octet-stream")},
    )


HubProxy.request = staticmethod(_request)
HubProxy.anonymous_request = staticmethod(_anonymous_request)
HubProxy.get = staticmethod(_get)
HubProxy.get_or_raise = staticmethod(_get_or_raise)
HubProxy.resolve_by_typeid = staticmethod(_resolve_by_typeid)
HubProxy.post = staticmethod(_post)
HubProxy.invoke_raw = staticmethod(_invoke_raw)
HubProxy.delete = staticmethod(_delete)
HubProxy.put = staticmethod(_put)
HubProxy.upload_entity_file = staticmethod(_upload_entity_file)
