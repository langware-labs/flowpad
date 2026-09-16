"""The one HTTP shape every source uses, and THE status → error table.

Sources do parsing and mapping, not transport bookkeeping. What is identical across providers
— the request ceiling, a transport failure, a status code — becomes a contract error here, so a
source's ``fetch`` is about the provider and nothing else.

The timeout is a ceiling on one round-trip, never a retry budget: there is no retry. The
application decides what a failure means; the next scheduled pass is its retry.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected, SourceError, SourceUnavailable
from flow_sdk.sources.values.origin import CloudOrigin

#: Ceiling for a single request. Not a retry or backoff budget.
REQUEST_TIMEOUT_SECONDS = 20


def client(timeout: float = REQUEST_TIMEOUT_SECONDS) -> httpx.AsyncClient:
    """A client with the house ceiling, or a provider's own when it has one. The caller owns the
    context manager."""
    return httpx.AsyncClient(timeout=timeout, follow_redirects=True)


def error_for_status(status: int, hint: str = "", *, origin: Optional[CloudOrigin] = None) -> SourceError:
    """One copy of the table, because a second one diverges: a 429 read as a refusal would stop
    a source over a rate limit."""
    detail = f"HTTP {status}{f' — {hint}' if hint else ''}"
    if status in (401, 403):
        return AccessDenied(detail, origin=origin)
    if status == 404:
        return NotFound(detail, origin=origin)
    if status == 429 or status >= 500:
        return SourceUnavailable(detail, origin=origin)
    return Rejected(detail, origin=origin)


async def request(
    http: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    ok_statuses: tuple[int, ...] = (),
    hint: str = "",
    origin: Optional[CloudOrigin] = None,
    **kwargs: Any,
) -> httpx.Response:
    """One request; any failure is a contract error. ``ok_statuses`` names non-2xx codes the
    caller handles itself (a 304 for a conditional request)."""
    try:
        response = await http.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        raise SourceUnavailable(f"{method} {url}: {exc}", origin=origin) from exc
    if response.status_code < 400 or response.status_code in ok_statuses:
        return response
    raise error_for_status(response.status_code, hint, origin=origin)


async def request_json(http: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    """:func:`request`, decoded. HTML on a JSON route is a provider having a bad minute."""
    response = await request(http, method, url, **kwargs)
    try:
        return response.json()
    except ValueError as exc:
        raise SourceUnavailable(f"{method} {url}: undecodable JSON: {exc}") from exc


__all__ = ["REQUEST_TIMEOUT_SECONDS", "client", "error_for_status", "request", "request_json"]
