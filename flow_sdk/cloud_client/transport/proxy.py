"""Transparent HTTP reverse proxy to the Flowpad Hub.

``CloudProxy`` is the HTTP counterpart to the WebSocket proxy
(``ws_client.HubWebSocketManager``): it forwards an incoming Starlette request to
the hub **carrying the HTTP method verbatim**, swapping only the base URL. It does
*not* infer the verb from anything — which is precisely why it cannot reproduce the
class of bug where a roster ``GET`` got reflected to the hub as a destructive
``DELETE`` (the "Cloud request rejected" inbox toast).

Auth + error reporting are reused, not duplicated: the inner client is the shared
``FlowpadClient`` httpx client, whose event hooks (``client_hooks._on_request`` /
``_on_response``) inject the live bearer token, handle expiry, and report hub
4xx/5xx. The proxy therefore only has to carry method/path/body/headers faithfully.

Validated standalone across 49 cases (CRUD, query/JSON/form params, multipart and
large uploads, binary/large downloads, chunked + SSE streaming, Range/206, gzip
passthrough, redirect non-follow, hop-by-hop stripping, framing, connection
lifecycle, the file+params message-send shape) before landing here.
"""

from __future__ import annotations

import httpx
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.client_hooks import PASSTHROUGH_EXTENSION

# RFC 7230 §6.1 hop-by-hop headers — never forwarded end-to-end.
_HOP: set[bytes] = {
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
# Outbound we additionally drop Host (httpx sets the hub's authority), any stale
# Authorization (the FlowpadClient request hook injects the live bearer token), and
# Hub-Reflect (a local-only routing directive — the hub must never see it).
_HOP_REQ: set[bytes] = _HOP | {b"host", b"authorization", b"hub-reflect"}


class CloudProxy:
    """Forward a Starlette request to the hub, preserving the method verbatim."""

    def __init__(self, client: FlowpadClient | None = None) -> None:
        # Reuse the hooked FlowpadClient so token injection + error reporting are
        # shared with every other outbound hub call (and the WS side's creds).
        self._fp = client or FlowpadClient(ApiConfig.from_env())

    async def _client(self) -> httpx.AsyncClient:
        return await self._fp._get_client()

    def _target(self, request: Request, url: str | httpx.URL | None) -> httpx.URL:
        """Resolve the hub URL. When ``url`` is None, forward the incoming graph
        path verbatim (the local ``/api/v1/graph/...`` path is byte-identical to
        the hub's), preserving percent-encoding via ``raw_path``."""
        if url is not None:
            return httpx.URL(url)
        # Lazy import keeps ``import flow_sdk.cloud_client`` light (hub_http pulls the
        # db layer) — import from this package's own modules, not the utils shim.
        from flow_sdk.cloud_client.shared.errors import HubError
        from flow_sdk.cloud_client.transport.hub_http import hub_base_url

        base = hub_base_url()
        if not base:
            raise HubError(0, "hub not configured (FLOWPAD_HUB_URL unset)")
        raw_path = request.scope.get("raw_path") or request.url.path.encode()
        qs = request.scope.get("query_string") or b""
        full = raw_path + (b"?" + qs if qs else b"")
        try:
            return httpx.URL(base).copy_with(raw_path=full)
        except Exception:
            return httpx.URL(str(base).rstrip("/") + full.decode("latin-1"))

    def _build(self, client: httpx.AsyncClient, request: Request, target: httpx.URL) -> httpx.Request:
        fwd = [(k, v) for (k, v) in request.headers.raw if k.lower() not in _HOP_REQ]
        clen = request.headers.get("content-length")
        te = (request.headers.get("transfer-encoding") or "").lower()
        has_body = (clen not in (None, "0")) or ("chunked" in te)
        content = request.stream() if has_body else None
        # Mark the hop as a passthrough so the shared client's response hook keeps
        # its hands off the body: this response is streamed to the caller, and a
        # hook-side read would consume the stream and truncate it to zero bytes.
        return client.build_request(
            request.method,
            target,
            headers=fwd,
            content=content,
            extensions={PASSTHROUGH_EXTENSION: True},
        )

    async def __call__(self, request: Request, url: str | httpx.URL | None = None) -> Response:
        """Stream the forwarded response straight back to the caller."""
        client = await self._client()
        req = self._build(client, request, self._target(request, url))
        try:
            resp = await client.send(req, stream=True)
        except httpx.RequestError as e:
            return Response(f"hub unreachable: {e!s}".encode(), status_code=502)

        filtered = [(k, v) for (k, v) in resp.headers.raw if k.lower() not in _HOP]

        async def _close() -> None:
            await resp.aclose()

        out = StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, background=BackgroundTask(_close))
        out.raw_headers = filtered  # full fidelity (dup Set-Cookie, exact CL/CE/CT)
        return out
