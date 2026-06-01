"""GET /api/v1/version/check — installed + latest PyPI + GitHub Releases."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from flow_sdk import __version__
from flow_sdk.utils import hub

logger = logging.getLogger(__name__)

router = APIRouter()

PYPI_URL = "https://pypi.org/pypi/flowpad/json"
GITHUB_RELEASES_URL = "https://api.github.com/repos/langware-labs/flowpad/releases"
HTTP_TIMEOUT = 8.0
MAX_RELEASES = 20
# GitHub unauthenticated quota is 60/hr — cache long enough that a chatty
# popover (open/close/open) doesn't burn it.
_CACHE_TTL_S = 300.0
_cache: dict[str, tuple[float, "VersionCheckResponse"]] = {}


class PypiInfo(BaseModel):
    current: str
    latest: Optional[str] = None
    update_available: bool = False
    error: Optional[str] = None


class ReleaseInfo(BaseModel):
    tag: str
    name: Optional[str] = None
    body: Optional[str] = None
    published_at: Optional[str] = None
    html_url: Optional[str] = None


class HubInfo(BaseModel):
    version: Optional[str] = None


class VersionCheckResponse(BaseModel):
    pypi: PypiInfo
    latest_release: Optional[ReleaseInfo] = None
    releases: list[ReleaseInfo] = []
    github_error: Optional[str] = None
    hub: Optional[HubInfo] = None


def _normalize_tag(tag: str) -> str:
    return tag.lstrip("vV")


def _compare_versions(current: str, latest: str) -> bool:
    """True if ``latest`` is newer than ``current``. Falls back to string != on parse errors."""
    try:
        from packaging.version import InvalidVersion, Version

        try:
            return Version(latest) > Version(current)
        except InvalidVersion:
            return latest != current
    except ImportError:
        return latest != current


async def _fetch_pypi(client: httpx.AsyncClient) -> PypiInfo:
    try:
        resp = await client.get(PYPI_URL, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        latest = (data.get("info") or {}).get("version")
        if not isinstance(latest, str):
            latest = None
        update_available = bool(latest) and _compare_versions(__version__, latest)
        return PypiInfo(
            current=__version__,
            latest=latest,
            update_available=update_available,
        )
    except Exception as exc:
        logger.warning("[version/check] PyPI fetch failed: %s", exc)
        return PypiInfo(current=__version__, error=str(exc))


async def _fetch_github(client: httpx.AsyncClient) -> tuple[list[ReleaseInfo], Optional[str]]:
    try:
        resp = await client.get(
            GITHUB_RELEASES_URL,
            timeout=HTTP_TIMEOUT,
            headers={"Accept": "application/vnd.github+json"},
        )
        resp.raise_for_status()
        raw = resp.json()
        if not isinstance(raw, list):
            return [], None
        releases: list[ReleaseInfo] = []
        for r in raw[:MAX_RELEASES]:
            tag = r.get("tag_name")
            if not isinstance(tag, str):
                continue
            if r.get("draft") or r.get("prerelease"):
                continue
            releases.append(
                ReleaseInfo(
                    tag=_normalize_tag(tag),
                    name=r.get("name") or None,
                    body=r.get("body") or None,
                    published_at=r.get("published_at") or None,
                    html_url=r.get("html_url") or None,
                )
            )
        # GitHub returns by created_at; sort by published_at desc so the truly latest release is first.
        releases.sort(key=lambda r: r.published_at or "", reverse=True)
        return releases, None
    except Exception as exc:
        logger.warning("[version/check] GitHub fetch failed: %s", exc)
        return [], str(exc)


@router.get("/api/v1/version/check", response_model=VersionCheckResponse)
async def check_version() -> VersionCheckResponse:
    cached = _cache.get("v1")
    if cached and time.monotonic() - cached[0] < _CACHE_TTL_S:
        return cached[1]
    async with httpx.AsyncClient() as client:
        pypi_info, github_result, hub_raw = await asyncio.gather(
            _fetch_pypi(client),
            _fetch_github(client),
            hub.get_info(),
        )
    releases, github_error = github_result
    hub_info = HubInfo(version=hub_raw.get("version")) if hub_raw else None
    resp = VersionCheckResponse(
        pypi=pypi_info,
        latest_release=releases[0] if releases else None,
        releases=releases,
        github_error=github_error,
        hub=hub_info,
    )
    # Only cache when both upstreams succeeded — keeps a transient outage from
    # pinning a broken response for 5 minutes.
    if pypi_info.error is None and github_error is None:
        _cache["v1"] = (time.monotonic(), resp)
    return resp
