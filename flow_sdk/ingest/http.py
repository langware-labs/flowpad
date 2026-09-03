"""The one HTTP shape every driver uses.

Drivers should do parsing and mapping, not transport bookkeeping. Everything
that is identical across providers — the request ceiling, turning a transport
failure into a classified ``SourceError``, turning a status code into one —
lives here, so a driver's ``fetch`` is about the provider and nothing else.

The timeout is a **ceiling on one round-trip, not a retry budget** (the same
distinction ``provider_probe.PROBE_TIMEOUT_SECONDS`` draws). A slow feed is
slow; the next scheduled tick is the retry.
"""
from __future__ import annotations

from typing import Optional

import httpx

from flow_sdk.ingest.health import SourceError

#: Ceiling for a single request. Not a retry or backoff budget.
REQUEST_TIMEOUT_SECONDS = 20


def client() -> httpx.AsyncClient:
    """An client with the house timeout. Callers own the context manager."""
    return httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=True)


async def request(
    http: Optional[httpx.AsyncClient],
    method: str,
    url: str,
    *,
    headers: Optional[dict] = None,
    params: Optional[dict] = None,
    json: Optional[dict] = None,
    ok_statuses: tuple[int, ...] = (),
    hint: str = "",
) -> httpx.Response:
    """One request, raising a classified ``SourceError`` on any failure.

    ``ok_statuses`` names non-2xx codes the caller handles itself — a 304 for a
    conditional request, or a 401 a driver maps to its own code — so they come
    back as a response rather than an error. Pass ``http=None`` to open (and
    close) a house client for this one call.
    """
    if http is None:
        async with client() as owned:
            return await request(
                owned, method, url, headers=headers, params=params, json=json,
                ok_statuses=ok_statuses, hint=hint,
            )
    try:
        response = await http.request(method, url, headers=headers or None, params=params, json=json)
    except httpx.HTTPError as exc:
        raise SourceError.transient("network_error", str(exc)) from exc

    if response.status_code in ok_statuses or response.status_code < 400:
        return response
    raise SourceError.for_status(response.status_code, hint)


async def request_json(
    http: Optional[httpx.AsyncClient],
    method: str,
    url: str,
    **kwargs,
):
    """:func:`request`, decoded. An undecodable body is ``bad_json`` transient —
    a provider that answers HTML on a JSON route is having a bad minute, not a
    misconfiguration."""
    response = await request(http, method, url, **kwargs)
    try:
        return response.json()
    except ValueError as exc:
        raise SourceError.transient("bad_json", f"{method} {url}: {exc}") from exc


async def get(
    http: httpx.AsyncClient,
    url: str,
    *,
    headers: Optional[dict] = None,
    params: Optional[dict] = None,
    ok_statuses: tuple[int, ...] = (),
    hint: str = "",
) -> httpx.Response:
    """GET ``url`` — :func:`request` with the method filled in.

    ``params`` is forwarded like every other argument. It was the one thing this helper
    dropped, which is why two drivers hand-merged a query string onto the URL before calling
    it — the same encoding httpx already does, spelled a second way.
    """
    return await request(http, "GET", url, headers=headers, params=params, ok_statuses=ok_statuses, hint=hint)
