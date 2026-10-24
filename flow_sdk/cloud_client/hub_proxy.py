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
from typing import Any, Awaitable, Callable, Mapping, Optional

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from flow_sdk.cloud_client.client_hooks import ANONYMOUS_EXTENSION, PASSTHROUGH_EXTENSION, HubAuthExpiredError
from flow_sdk.cloud_client.shared.errors import HubError, _extract_error_code, _extract_reason, classify_hub_failure
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind

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
# ``x-cookie-gate``: this machine's gate secret, the header form of the same local credential.
DROP_OUTBOUND: frozenset[bytes] = HOP_BY_HOP | {
    b"host",
    b"authorization",
    b"hub-reflect",
    b"cookie",
    b"x-cookie-gate",
}
DROP_INBOUND: frozenset[bytes] = HOP_BY_HOP | {b"set-cookie"}
# The only hub surface a forwarded request may reach.
FORWARDABLE_PREFIX = "/api/v1/graph/"

DEFAULT_TIMEOUT = httpx.Timeout(10)
# A file moving whole: a long read (download) or a long write (upload). Same budgets as before.
DOWNLOAD_TIMEOUT = httpx.Timeout(connect=10, write=10, read=600, pool=5)
UPLOAD_TIMEOUT = httpx.Timeout(connect=10, write=600, read=60, pool=5)
# A deploy answers once its machine is up: create + boot + health is minutes on a cloud VM.
DEPLOY_TIMEOUT = httpx.Timeout(connect=10, write=10, read=900, pool=5)
# An anonymous call (diagnosis brief / submit) may carry a report.
ANONYMOUS_TIMEOUT = httpx.Timeout(30)
# Same budget as the old CloudProxy (the client default). Streamed, so it bounds each read/write gap, not a whole transfer.
FORWARD_TIMEOUT = httpx.Timeout(30)


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


# Rows per page when walking a whole hub list (``HubProxy.walk``).
WALK_PAGE_SIZE = 200


@dataclass
class HubWalk:
    """A hub list read page by page. ``complete`` is True only when the hub said the last page was the
    last (``has_more`` false): a caller that prunes the rows a list no longer holds must prune only then —
    a failed, partial or timed-out walk is missing rows it never saw. ``error`` is the failure that cut it."""

    rows: list[dict] = field(default_factory=list)
    complete: bool = False
    pages: int = 0
    error: Optional[HubError] = None
    page_seconds: list[float] = field(default_factory=list)  # how long each page took to come back


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


def _require_url(*args: Any, **kwargs: Any) -> str:
    """``graph_url``, or ``HubError(not_configured)`` when this box has no hub."""
    url = graph_url(*args, **kwargs)
    if not url:
        raise HubError(0, "no hub configured", kind=HubFailureKind.NOT_CONFIGURED)
    return url


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
            await _report_unreachable(method, url, e)
            raise HubError(0, str(e) or type(e).__name__) from e
        _note_reach(resp.status_code)
        return resp

    # ── graph calls from semantic args ───────────────────────────────────────────────
    #
    # Two contracts, nothing else: ``call`` raises ``HubError`` for every way a call can fail
    # (no hub configured included); ``try_call`` is the same call answering None instead.

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
        payload: Any = None,
        files: Any = None,
        timeout: httpx.Timeout | float | None = None,
        strict: bool = False,
        anonymous: bool = False,
        raw: bool = False,
    ) -> Any:
        """Call a hub graph endpoint and answer its envelope's ``data`` (``{}`` when empty).

        Raises ``HubError``: ``not_configured`` with no hub, ``signed_out`` / ``offline`` when
        nothing came back, the hub's status on any non-200, ``server_error`` on a 200 that is not
        JSON. ``strict`` also refuses a 200 envelope that says FAIL, and refuses to send at all
        without a credential. ``raw`` answers the body's bytes; ``anonymous`` sends no login.
        """
        url = _require_url(entity_type, entity_id, action, sub_path, scope=scope)
        if strict and not anonymous:
            await _require_credential()
        if timeout is None:
            timeout = UPLOAD_TIMEOUT if files else (DOWNLOAD_TIMEOUT if raw else DEFAULT_TIMEOUT)
        if method.upper() == "DELETE" and payload is None:
            payload = {}  # the hub parses DELETE bodies (``members`` expects one)
        resp = await cls.send(
            method, url, params=params, json=None if files else payload, files=files,
            timeout=timeout, anonymous=anonymous,
        )  # fmt: skip
        return _unwrap(resp, method=method, url=url, strict=strict, raw=raw)

    @classmethod
    async def walk(
        cls,
        entity_type: Any,
        *,
        match: Any = None,
        order_by: Any = None,
        page_size: int = WALK_PAGE_SIZE,
        scope: list[tuple[str, str]] | None = None,
        timeout: httpx.Timeout | float | None = None,
    ) -> HubWalk:
        """Every row of a hub list, one page at a time, until ``has_more`` is false (the hub's list contract:
        paging inside ``filter`` next to a ``match``). Each next page is asked for by the answer's
        ``next_cursor`` (``after``: right after the last row, no rescan) when it carries one, else by its
        ``next_offset``.

        Never raises: a page that fails ends the walk with ``complete=False`` and the rows read so far.
        Each page has its own ``timeout`` (``DEFAULT_TIMEOUT``), so one slow hub costs one page's budget.
        Ordered oldest first by default, so a row the hub gains mid-walk lands on a later page.
        """
        import json as _json  # noqa: PLC0415
        import time  # noqa: PLC0415

        out = HubWalk()
        try:
            url = _require_url(entity_type, scope=scope)
        except HubError as e:
            out.error = e
            return out
        offset = 0
        after: str | None = None
        order = order_by if order_by is not None else [{"created_date": "asc"}]
        while True:
            page_filter = {"match": match or {}, "limit": page_size, "order_by": order}
            if after:
                page_filter["after"] = after
            elif offset:
                page_filter["offset"] = offset
            started = time.monotonic()
            try:
                resp = await cls.send(
                    "GET", url, params={"filter": _json.dumps(page_filter)}, timeout=timeout or DEFAULT_TIMEOUT
                )
                out.page_seconds.append(time.monotonic() - started)
                # Strict: a 200 whose envelope says FAIL is a failed page, not an empty one.
                _unwrap(resp, method="GET", url=url, strict=True)
                body = resp.json()
                # Read ``data`` itself: an empty list is a real (empty) page, not "no answer".
                data = body.get("data") if isinstance(body, dict) else body
                if not isinstance(data, list):
                    # Not a list answer: nothing was listed, so nothing may be read as absent.
                    raise HubError(
                        200, f"list answer is not a list ({type(data).__name__})", kind=HubFailureKind.SERVER_ERROR
                    )
            except HubError as e:
                logger.info("[hub] walk %s stopped after %d page(s): %s", entity_type, out.pages, e)
                out.error = e
                return out
            rows = data
            out.rows.extend(r for r in rows if isinstance(r, dict))
            out.pages += 1
            has_more = body.get("has_more") if isinstance(body, dict) else None
            if has_more is None:
                # An answer without the paging fields did not page: it is whole only if it came back short.
                has_more = len(rows) >= page_size
                next_offset = offset + len(rows)
            else:
                next_offset = body.get("next_offset")
            if not has_more:
                out.complete = True
                return out
            next_cursor = body.get("next_cursor") if isinstance(body, dict) else None
            if isinstance(next_cursor, str) and next_cursor and next_cursor != after:
                after = next_cursor
                continue
            if after is not None:
                # A cursor walk's offsets count from its cursor, not from the top: no way to go on.
                out.error = HubError(200, f"list paging did not advance (next_cursor={next_cursor!r})")
                return out
            if not isinstance(next_offset, int) or next_offset <= offset:
                out.error = HubError(200, f"list paging did not advance (next_offset={next_offset!r})")
                return out
            offset = next_offset

    @classmethod
    async def try_call(cls, method: str, entity_type: Any, *args: Any, **kwargs: Any) -> Any:
        """``call``, answering None instead of raising ``HubError``."""
        try:
            return await cls.call(method, entity_type, *args, **kwargs)
        except HubError as e:
            logger.debug("[hub] %s %s answered nothing (%s): %s", method, entity_type, e.kind, e.reason)
            return None

    @classmethod
    async def download(
        cls,
        entity_type: Any,
        entity_id: str | None = None,
        action: str | None = None,
        sub_path: str | None = None,
        *,
        scope: list[tuple[str, str]] | None = None,
        params: Mapping[str, Any] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> bytes:
        """GET a file's bytes, streamed, firing ``on_progress(done, total)`` in ~1% steps.

        Raises ``HubError`` like ``call``. ``total`` is 0 when the hub sends no Content-Length.
        """
        if on_progress is None:
            return await cls.call("GET", entity_type, entity_id, action, sub_path, scope=scope, params=params, raw=True)
        url = _require_url(entity_type, entity_id, action, sub_path, scope=scope)
        resp = await cls.send("GET", url, params=params, timeout=DOWNLOAD_TIMEOUT, stream=True)
        try:
            if resp.status_code != 200:
                await resp.aread()
                _unwrap(resp, method="GET", url=url)  # raises the classified HubError
            total = int(resp.headers.get("Content-Length") or 0)
            buf = bytearray()
            reported = 0
            step = max(total // 100, _CHUNK) if total else _CHUNK
            async for chunk in resp.aiter_bytes():
                buf.extend(chunk)
                if len(buf) - reported >= step or (total and len(buf) >= total):
                    reported = len(buf)
                    await _progress(on_progress, reported, total)
            if reported != len(buf):
                await _progress(on_progress, len(buf), total or len(buf))
            return bytes(buf)
        finally:
            await resp.aclose()

    @classmethod
    async def upload(
        cls,
        entity_type: Any,
        entity_id: str | None,
        action: str | None,
        sub_path: str | None = None,
        *,
        files: dict,
        scope: list[tuple[str, str]] | None = None,
        params: Mapping[str, Any] | None = None,
        on_progress: ProgressCallback | None = None,
    ) -> Any:
        """POST one multipart file (``files={field: (name, bytes, content_type)}``).

        With ``on_progress`` the body is hand-built and streamed so progress can be reported
        between chunks (httpx's ``files=`` buffers it whole). Raises ``HubError`` like ``call``.
        """
        if on_progress is None:
            return await cls.call(
                "POST", entity_type, entity_id, action, sub_path, scope=scope, params=params, files=files
            )
        url = _require_url(entity_type, entity_id, action, sub_path, scope=scope)
        field_name, (fname, content, ctype) = next(iter(files.items()))
        boundary = _uuid.uuid4().hex
        preamble = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field_name}"; filename="{fname}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        epilogue = f"\r\n--{boundary}--\r\n".encode()
        total = len(preamble) + len(content) + len(epilogue)
        step = max(len(content) // 100, _CHUNK)

        async def _body():
            yield preamble
            mv = memoryview(content)
            sent = reported = 0
            while sent < len(content):
                piece = bytes(mv[sent : sent + _CHUNK])
                sent += len(piece)
                yield piece
                if sent - reported >= step or sent >= len(content):
                    reported = sent
                    await _progress(on_progress, len(preamble) + sent, total)
            yield epilogue
            await _progress(on_progress, total, total)

        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(total)}
        resp = await cls.send("POST", url, params=params, content=_body(), headers=headers, timeout=UPLOAD_TIMEOUT)
        return _unwrap(resp, method="POST", url=url)

    @classmethod
    async def exists(cls, typeid: Any) -> tuple[HubResolveState, Optional[dict[str, Any]]]:
        """Whether the hub holds this entity: ``present`` (with its data), ``absent`` (a definitive
        404) or ``indeterminate`` (no hub, unknown type, unreachable, any other status). Never raises.

        Cleanup decisions rest on it: "the hub is down" must never read as "the entity was deleted".
        """
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415 — pulls the db layer

        try:
            entity_type = BuiltinEntityType(typeid.type)
        except ValueError:
            return ("indeterminate", None)
        try:
            return ("present", await cls.call("GET", entity_type, typeid.id))
        except HubError as e:
            if e.status_code == 404:
                return ("absent", None)
            logger.warning("[hub] exists %s: indeterminate (%s)", typeid, e.reason)
            return ("indeterminate", None)

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

        body = {"status": "FAIL", "message": e.reason or "hub unreachable", "data": e.envelope_data}
        return Response(json.dumps(body).encode(), status_code=e.http_status, media_type="application/json")

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
        )
        # ``resp.content`` is the decoded body; the encoding headers no longer describe it.
        hdrs = [
            (k, v)
            for (k, v) in cls.inbound_headers(list(resp.headers.raw))
            if k.lower() not in (b"content-encoding", b"content-length")
        ]
        return HubAnswer(resp.status_code, hdrs, resp.content)


def _unwrap(resp: httpx.Response, *, method: str = "", url: Any = "", strict: bool = False, raw: bool = False) -> Any:
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


async def _require_credential() -> None:
    """``signed_out`` before anything is sent when this box holds no hub login."""
    from flow_sdk.cloud_client.client_hooks import resolve_hub_credential  # noqa: PLC0415

    try:
        credential = await resolve_hub_credential()
    except HubAuthExpiredError as e:
        raise HubError(401, "auth expired", kind=HubFailureKind.SIGNED_OUT) from e
    if not credential:
        raise HubError(0, "signed out", kind=HubFailureKind.SIGNED_OUT)


_CHUNK = 256 * 1024


async def _report_unreachable(method: str, url: Any, e: Exception) -> None:
    """The status-0 report behind the UI's "hub unreachable" warning (as ``FlowpadClient.request`` did)."""
    from flow_sdk.cloud_client.client_hooks import request_path  # noqa: PLC0415
    from flow_sdk.cloud_client.error_reporter import hub_error_reporter  # noqa: PLC0415

    try:
        await hub_error_reporter.report(
            status_code=0, method=method.upper(), path=request_path(httpx.URL(str(url))), message=str(e)
        )
    except Exception:  # noqa: BLE001 — reporting must never mask the failure itself
        logger.debug("[hub] unreachable report failed", exc_info=True)


async def _progress(on_progress: ProgressCallback, done: int, total: int) -> None:
    try:
        await on_progress(done, total)
    except Exception:  # noqa: BLE001 — a progress bar must never fail the transfer
        pass
