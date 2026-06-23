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
from flow_sdk.server import self_update
from flow_sdk.server.launch import get_status
from flow_sdk.utils import hub
from flow_sdk.utils.semver import _cmp_key, is_newer, string2semver

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


class PypiRelease(BaseModel):
    version: str
    published_at: Optional[str] = None
    yanked: bool = False


class PypiInfo(BaseModel):
    current: str
    latest: Optional[str] = None
    update_available: bool = False
    error: Optional[str] = None
    # Full version history from PyPI (newest-first), so the version-popover
    # "Change version" picker can offer every published release — GitHub
    # Releases only covers a subset and lags behind PyPI.
    releases: list[PypiRelease] = []


class ReleaseInfo(BaseModel):
    tag: str
    name: Optional[str] = None
    body: Optional[str] = None
    published_at: Optional[str] = None
    html_url: Optional[str] = None


class HubInfo(BaseModel):
    version: Optional[str] = None
    deployed_at: Optional[str] = None
    generated_at: Optional[str] = None
    # Fixed community/support project id (the app opens support tickets against
    # it). Null on older hubs that don't advertise it.
    community_project_id: Optional[str] = None


class VersionCheckResponse(BaseModel):
    pypi: PypiInfo
    latest_release: Optional[ReleaseInfo] = None
    releases: list[ReleaseInfo] = []
    github_error: Optional[str] = None
    hub: Optional[HubInfo] = None


class InstallVersionRequest(BaseModel):
    version: str


class InstallVersionResponse(BaseModel):
    success: bool
    restarting: bool = False
    # Reason code the UI can branch on for the manual-command fallback.
    reason: Optional[str] = None
    error: Optional[str] = None
    output: Optional[str] = None


def _normalize_tag(tag: str) -> str:
    return tag.lstrip("vV")


def _optional_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _hub_info_from_raw(hub_raw: dict[str, Any] | None) -> Optional[HubInfo]:
    if not hub_raw:
        return None
    return HubInfo(
        community_project_id=_optional_str(hub_raw.get("community_project_id")),
        version=_optional_str(hub_raw.get("version")),
        deployed_at=_optional_str(hub_raw.get("deployed_at")),
        generated_at=_optional_str(hub_raw.get("generated_at")),
    )


def _pypi_releases(releases_raw: Any) -> list[PypiRelease]:
    """Build a newest-first list of published versions from the PyPI ``releases`` map.

    Each value is a list of uploaded files; we take the earliest file's upload
    time as the version's publish date and treat a version as yanked only when
    every file for it is yanked.
    """
    if not isinstance(releases_raw, dict):
        return []
    # Pair each release with its parsed-semver sort key so we never re-parse.
    out: list[tuple[PypiRelease, tuple]] = []
    for version, files in releases_raw.items():
        if not isinstance(version, str):
            continue
        parsed = string2semver(version)
        if parsed is None:
            continue
        published_at: Optional[str] = None
        all_yanked = True
        if isinstance(files, list):
            for f in files:
                if not isinstance(f, dict):
                    continue
                if not f.get("yanked"):
                    all_yanked = False
                ts = f.get("upload_time_iso_8601") or f.get("upload_time")
                if isinstance(ts, str) and (published_at is None or ts < published_at):
                    published_at = ts
        else:
            all_yanked = False
        out.append((PypiRelease(version=version, published_at=published_at, yanked=all_yanked), _cmp_key(parsed)))
    # Newest-first by the shared semver ordering (so 0.2.9 < 0.2.10).
    out.sort(key=lambda pair: pair[1], reverse=True)
    return [release for release, _ in out]


async def _fetch_pypi(client: httpx.AsyncClient) -> PypiInfo:
    try:
        resp = await client.get(PYPI_URL, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        latest = (data.get("info") or {}).get("version")
        if not isinstance(latest, str):
            latest = None
        # is_newer (shared with electron/semver.js) treats an "extra" tag like
        # "0.2.40-local" as newer than "0.2.40" instead of mis-parsing it.
        update_available = bool(latest) and is_newer(__version__, latest)
        return PypiInfo(
            current=__version__,
            latest=latest,
            update_available=update_available,
            releases=_pypi_releases(data.get("releases")),
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
    hub_info = _hub_info_from_raw(hub_raw)
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


@router.post("/api/v1/version/install", response_model=InstallVersionResponse)
async def install_version(req: InstallVersionRequest) -> InstallVersionResponse:
    """Reinstall a pinned flowpad version and restart the server via the monitor.

    Cross-platform / Electron-independent: the actual restart is performed by the
    ``flow_sdk.server.launch`` monitor, which both the CLI (`flow start`) and the
    desktop app use. When no monitor is running (e.g. a dev `python -m
    flow_sdk.server.run`) or this is an editable checkout, the endpoint refuses
    with a ``reason`` so the UI can show a manual command instead.
    """
    version = req.version.strip()
    if not self_update.is_valid_version(version):
        return InstallVersionResponse(success=False, reason="invalid", error="Invalid version string")
    if version == __version__:
        return InstallVersionResponse(success=False, reason="same_version", error="Already on this version")
    if self_update.is_editable_install():
        return InstallVersionResponse(
            success=False,
            reason="editable",
            error="This is an editable/dev install — reinstall is disabled.",
        )
    if not get_status().get("monitor_alive"):
        return InstallVersionResponse(
            success=False,
            reason="no_monitor",
            error="No monitor process is running, so the server can't auto-restart.",
        )

    ok, output = await asyncio.to_thread(self_update.reinstall_version, version)
    if not ok:
        return InstallVersionResponse(
            success=False, reason="install_failed", error="Install failed", output=output[-2000:]
        )

    self_update.schedule_restart()
    return InstallVersionResponse(success=True, restarting=True)
