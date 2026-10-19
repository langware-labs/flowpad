"""The one HTTP shape every source uses, and THE status → error table.

Sources do parsing and mapping, not transport bookkeeping. What is identical across providers
— the request ceiling, a transport failure, a status code — becomes a contract error here, so a
source's ``fetch`` is about the provider and nothing else.

The timeout is a ceiling on one round-trip, never a retry budget: there is no retry. The
application decides what a failure means; the next scheduled pass is its retry.
"""
from __future__ import annotations

import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, Mapping, Optional

import httpx

from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected, SourceError, SourceUnavailable
from flow_sdk.sources.values.origin import CloudOrigin

#: Ceiling for a single request. Not a retry or backoff budget.
REQUEST_TIMEOUT_SECONDS = 20


def client(timeout: float = REQUEST_TIMEOUT_SECONDS) -> httpx.AsyncClient:
    """A client with the house ceiling, or a provider's own when it has one. The caller owns the
    context manager."""
    return httpx.AsyncClient(timeout=timeout, follow_redirects=True)


def rate_limited(headers: Optional[Mapping[str, str]]) -> bool:
    """Whether a response's headers say "slow down": a ``Retry-After``, or no requests left in the
    window (``X-RateLimit-Remaining: 0`` / ``RateLimit-Remaining: 0``). A provider that answers a
    rate limit with 403 (GitHub) is then not a refusal."""
    if not headers:
        return False
    lowered = headers if isinstance(headers, httpx.Headers) else {str(k).lower(): v for k, v in headers.items()}
    if lowered.get("retry-after"):
        return True
    return any(str(lowered.get(name, "")).strip() == "0" for name in ("x-ratelimit-remaining", "ratelimit-remaining"))


def error_for_status(
    status: int,
    hint: str = "",
    *,
    reason: str = "",
    origin: Optional[CloudOrigin] = None,
    headers: Optional[Mapping[str, str]] = None,
) -> SourceError:
    """One copy of the table, because a second one diverges: a 429 read as a refusal would stop
    a source over a rate limit. ``reason`` is the service's own words, always said; ``hint`` (where to
    look: the address, the key) only for a status the caller can fix -- a rate limit or a failing
    service is not its doing."""
    limited = status == 429 or (status == 403 and rate_limited(headers))
    if limited:
        hint = "the service is limiting how fast we call it; the next pass tries again"
    elif status >= 500:
        hint = "the service failed; the next pass tries again"
    detail = " — ".join(part for part in (f"HTTP {status}", reason, hint) if part)
    if limited:
        return SourceUnavailable(detail, origin=origin)
    if status in (401, 403):
        return AccessDenied(detail, origin=origin)
    if status == 404:
        return NotFound(detail, origin=origin)
    if status >= 500:
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
    raise error_for_status(response.status_code, hint, origin=origin, headers=response.headers)


async def request_json(http: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    """:func:`request`, decoded. HTML on a JSON route is a provider having a bad minute."""
    response = await request(http, method, url, **kwargs)
    try:
        return response.json()
    except ValueError as exc:
        raise SourceUnavailable(f"{method} {url}: undecodable JSON: {exc}") from exc


@asynccontextmanager
async def stream(
    http: httpx.AsyncClient,
    url: str,
    *,
    headers: Optional[dict] = None,
    hint: str = "",
    origin: Optional[CloudOrigin] = None,
    chunk_size: int = 65536,
    redact: str = "",
) -> AsyncIterator[AsyncIterator[bytes]]:
    """A GET whose body is streamed — the shape ``Openable.open`` yields. A failure is a contract
    error like :func:`request`'s; ``redact`` (a token in the URL) never reaches an error's text."""
    shown = url.replace(redact, "<redacted>") if redact else url
    try:
        async with http.stream("GET", url, headers=headers) as response:
            if response.status_code >= 400:
                raise error_for_status(response.status_code, hint, origin=origin, headers=response.headers)
            yield response.aiter_bytes(chunk_size)
    except httpx.HTTPError as exc:
        raise SourceUnavailable(f"GET {shown}: {str(exc).replace(redact, '<redacted>') if redact else exc}", origin=origin) from exc


_NEXT_LINK = re.compile(r'<([^>]*)>\s*;[^,]*\brel="?next"?')


def next_link(headers: Mapping[str, str]) -> Optional[str]:
    """The full URL of an RFC 5988 ``Link: <...>; rel="next"`` header, or ``None`` on the last page."""
    if not isinstance(headers, httpx.Headers):
        headers = {str(k).lower(): v for k, v in (headers or {}).items()}
    found = _NEXT_LINK.search(headers.get("link") or "")
    return found.group(1) if found else None


async def paginate(
    http: httpx.AsyncClient,
    path: str,
    *,
    params: Optional[dict] = None,
    key: Optional[str] = None,
    max_pages: int = 50,
    page_kwargs: Optional[Callable[[int, str], Mapping[str, Any]]] = None,
    **kwargs: Any,
) -> AsyncIterator[Any]:
    """Each item of a JSON list response — or of ``body[key]`` when the list rides in an object
    (``{"total_count": .., "check_runs": [..]}``) — following ``rel="next"`` links until there is
    none or ``max_pages`` pages were read. The next link carries its own query, so ``params`` go on
    the first request only. ``kwargs`` go on every request; ``page_kwargs(page, url)`` adds a page's
    own (a conditional header, a per-page hint). A rate limit is ``SourceUnavailable``, never a refusal."""
    url: Optional[str] = path
    for page in range(max_pages):
        extra = dict(page_kwargs(page, url)) if page_kwargs is not None else {}
        response = await request(http, "GET", url, params=params if page == 0 else None, **{**kwargs, **extra})
        try:
            body = response.json()
        except ValueError as exc:
            raise SourceUnavailable(f"GET {url}: undecodable JSON: {exc}") from exc
        for item in (body.get(key) or []) if key is not None else (body or []):
            yield item
        url = next_link(response.headers)
        if not url:
            return


__all__ = ["REQUEST_TIMEOUT_SECONDS", "client", "error_for_status", "next_link", "paginate", "rate_limited", "request", "request_json", "stream"]
