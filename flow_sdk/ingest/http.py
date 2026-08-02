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


async def get(
    http: httpx.AsyncClient,
    url: str,
    *,
    headers: Optional[dict] = None,
    ok_statuses: tuple[int, ...] = (),
    hint: str = "",
) -> httpx.Response:
    """GET ``url``, raising a classified ``SourceError`` on any failure.

    ``ok_statuses`` names non-2xx codes the caller handles itself — a 304 for a
    conditional request, say — so they come back as a response rather than an
    error.
    """
    try:
        response = await http.get(url, headers=headers or None)
    except httpx.HTTPError as exc:
        raise SourceError.transient("network_error", str(exc)) from exc

    if response.status_code in ok_statuses or response.status_code < 400:
        return response
    raise SourceError.for_status(response.status_code, hint)
