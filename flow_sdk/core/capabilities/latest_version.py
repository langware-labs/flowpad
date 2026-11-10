"""Newest published version of each harness CLI — the background update check.

Runs once after startup discovery, off the startup path. Each CLI declares
where its releases are published (``CapabilitySpec.latest_version_npm``);
this module asks the npm registry and keeps the answers for a day (in memory,
backed by a file so a restart doesn't re-ask). A failed lookup records
nothing, so an offline machine simply shows no update.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path

import httpx

from flow_sdk.instances.atomic import read_json, write_json_atomic
from flow_sdk.utils.semver import is_newer

_TTL_S = 24 * 3600
_REQUEST_TIMEOUT_S = 5.0
_REGISTRY = os.environ.get("FLOW_NPM_REGISTRY", "https://registry.npmjs.org")

#: What a vendor API says when the CLI is too old for the request.
TOO_OLD = re.compile(r"requires a newer version|unsupported client version|please (?:upgrade|update) (?:to|your)", re.I)

_cache: dict[str, dict] | None = None  # kind → {"version", "at"}
#: kind → the installed version a session proved too old ("" until a status build pins it).
_too_old: dict[str, str] = {}


def enabled() -> bool:
    return os.environ.get("FLOW_CLI_UPDATE_CHECK", "1") != "0"


def _cache_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "cli_latest_versions.json"


def _entries() -> dict[str, dict]:
    global _cache
    if _cache is None:
        _cache = read_json(_cache_path())
    return _cache


def _stale(entry: dict | None, now: float) -> bool:
    return now - float((entry or {}).get("at", 0)) > _TTL_S


def cached_latest(kind: str) -> str:
    """The newest version known for ``kind`` (empty when never looked up or stale)."""
    entry = _entries().get(kind)
    return "" if _stale(entry, time.time()) else str(entry.get("version") or "")


async def _fetch(client: httpx.AsyncClient, package: str) -> str | None:
    try:
        resp = await client.get(f"{_REGISTRY}/{package}/latest")
        resp.raise_for_status()
        version = resp.json().get("version")
        return str(version) if version else None
    except (httpx.HTTPError, ValueError):
        return None


async def refresh_latest_versions(*, force: bool = False) -> bool:
    """Look up every CLI whose entry is stale. True when a newer version was stored."""
    if not enabled():
        return False
    from flow_sdk.core.capabilities.registry import get_default_capability_specs  # noqa: PLC0415

    cache, now = _entries(), time.time()
    due = {
        s.kind: s.latest_version_npm
        for s in get_default_capability_specs()
        if s.latest_version_npm and (force or _stale(cache.get(s.kind), now))
    }
    if not due:
        return False
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
        found = await asyncio.gather(*(_fetch(client, pkg) for pkg in due.values()))
    changed = False
    for kind, version in zip(due, found):
        if version:
            changed |= (cache.get(kind) or {}).get("version") != version
            cache[kind] = {"version": version, "at": now}
    if any(found):
        await asyncio.to_thread(write_json_atomic, _cache_path(), cache)
    return changed


def update_state(kind: str, installed: str) -> tuple[str, str]:
    """``(latest_version, update)`` for one installed CLI: update is none|available|required."""
    if not installed:
        return "", "none"
    latest = cached_latest(kind)
    pinned = _too_old.get(kind)
    if pinned is not None:
        if pinned in ("", installed):
            _too_old[kind] = installed  # the error named no version: it was this one
            return latest, "required"
        del _too_old[kind]  # a newer install replaced it
    return latest, ("available" if latest and is_newer(installed, latest) else "none")


def note_session_error(kind: str, text: str) -> bool:
    """True when ``text`` is a vendor's too-old refusal; marks ``kind`` (when known) for update."""
    if not (text and TOO_OLD.search(text)):
        return False
    if kind and kind not in _too_old:
        _too_old[kind] = ""
        from flow_sdk.core.status import publish_status_changed  # noqa: PLC0415

        publish_status_changed()
    return True
