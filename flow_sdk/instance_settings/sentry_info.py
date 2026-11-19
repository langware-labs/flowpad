"""The sandbox's browser error-reporting config — pulled from the hub, never accepted from a caller.

The hub TRIGGERS a sync (``POST /api/v1/graph/compute_node/@local/sentry-info``, no body) on
every workspace-ready; the box then READS the value from the hub it is logged in to::

    GET /api/v1/graph/compute_node/sentry-info   (hub action, authenticated with the box's login)

A pull, not a push, because nothing on the box can tell the hub's call from anyone else's: the
sandbox gate admits the browser (grant cookie) and every worker on the box (``X-Cookie-Gate``)
just as it admits the hub. A write endpoint taking a DSN would let any of them send this box's
error reports somewhere else; a trigger can only make the box re-read the true value. That holds
for HTTP callers: a process running as the box's own user can still write ``config.json``
directly -- the same trust boundary that already covers ``runtime_kind`` and the cookie gate.

Stored via ``app_config`` (``<instance_dir>/config.json``) like ``runtime.py`` and
``llm_endpoint.py``: not a secret (a DSN is a public client key), and it must survive a restart
and an E2B pause/resume, which env does not.

Freshness: every AUTHORITATIVE hub answer (a value, an explicit ``null``, or "no such action")
stamps ``synced_at``. A value not re-confirmed for ``MAX_STALENESS_SECONDS`` reads as ``None``:
a box cut off from its hub stops reporting rather than reporting on a config nobody vouches for
any more. Being offline touches nothing else -- the stored value is kept and comes back the
moment the hub confirms it again.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from flow_sdk.cli import app_config
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.schema.data_spec.sentry_info_spec import SentryInfo, SentryInfoStatus, SyncOutcome, parse_sentry_info

logger = logging.getLogger(__name__)

_CONFIG_KEY = "sentry_info"
#: The tag an effective change rides to every open page (forwarded: ``tags/ws_forward.py``).
SENTRY_INFO_CHANGED = "sentry_info.changed"
#: How long a value lives without the hub re-confirming it. The hub syncs on every workspace
#: open and (throttled) on every READY poll, so a reachable hub re-confirms many times a day.
MAX_STALENESS_SECONDS = 7 * 24 * 3600

#: The hub action the box reads (``/graph/<type>/<action>``).
HUB_ENTITY_TYPE = "compute_node"
HUB_ACTION = "sentry-info"
#: How a hub WITHOUT that action answers (measured on a release/v0.29 hub, anonymous or signed in
#: alike): ``422 {"message": "Unknown resource type or action: sentry-info ..."}``. 404 is what any
#: other server would say. Only these two mean "this hub has no such action"; every other refusal
#: (a 400, a 401 without a code, a 403 from a policy or a gateway) says nothing about the hub's
#: support, so it must not switch a good value off.
_NO_SUCH_ACTION_STATUSES = frozenset({404, 422})


# Memo of the parsed record per instance NAME, re-checked against config.json's stamp -- the
# same reasons as ``runtime._cache``: this is on the bootstrap path, and the write may land in
# another process (the box runs several) than the one serving bootstrap.
_cache: dict[str, tuple[int | None, SentryInfo | None, float | None]] = {}
#: One hub read in flight per instance and event loop; concurrent triggers join it.
_inflight: dict[tuple[str, int], asyncio.Future] = {}


def _read() -> tuple[SentryInfo | None, float | None]:
    """The stored value and when the hub last vouched for it, ignoring expiry."""
    key = get_instance_settings().instance_name
    stamp = app_config.config_file_stamp()
    cached = _cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1], cached[2]
    record = app_config.get_config(_CONFIG_KEY)
    info, synced_at = None, None
    if isinstance(record, dict):
        info = parse_sentry_info(record.get("value"))
        raw_at = record.get("synced_at")
        synced_at = float(raw_at) if isinstance(raw_at, (int, float)) else None
    _cache[key] = (stamp, info, synced_at)
    return info, synced_at


def _expired(synced_at: float | None, now: float | None = None) -> bool:
    if synced_at is None:
        return True
    return ((now if now is not None else time.time()) - synced_at) > MAX_STALENESS_SECONDS


def get_sentry_info() -> SentryInfo | None:
    """The value to report with, or ``None``: never set, cleared, invalid, or gone stale."""
    info, synced_at = _read()
    if info is None or _expired(synced_at):
        return None
    return info


def sentry_info_status() -> SentryInfoStatus:
    """What ``GET @local/sentry-info`` answers: the effective value and how fresh it is."""
    info, synced_at = _read()
    return SentryInfoStatus(
        sentry_info=get_sentry_info(),
        synced_at=datetime.fromtimestamp(synced_at, tz=timezone.utc).isoformat() if synced_at else None,
        expired=info is not None and _expired(synced_at),
    )


def _store(info: SentryInfo | None) -> bool:
    """Record an authoritative answer; returns whether the EFFECTIVE value changed."""
    before = get_sentry_info()
    app_config.set_config(
        _CONFIG_KEY, {"value": info.model_dump(mode="json") if info else None, "synced_at": time.time()}
    )
    _cache.pop(get_instance_settings().instance_name, None)
    return before != info


async def _announce(info: SentryInfo | None) -> None:
    """Tell every open client, on the tag bus. Best-effort: a missed event leaves the next bootstrap right (it
    stamps ``sentry_info`` per request, outside the bootstrap cache, so there is nothing to invalidate)."""
    try:
        from flow_sdk.tags.bus import emit_tag  # noqa: PLC0415
        from flow_sdk.tags.envelope import target_of  # noqa: PLC0415

        emit_tag(
            SENTRY_INFO_CHANGED,
            target_of("sentry_info", "local"),
            {"sentry_info": info.model_dump(mode="json") if info else None},
        )
    except Exception:  # noqa: BLE001
        logger.debug("sentry_info: tag emit failed", exc_info=True)


async def _sync_once() -> SyncOutcome:
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
    from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
    from flow_sdk.instance_settings.privacy_mode import is_local_mode  # noqa: PLC0415
    from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

    if is_local_mode():
        return SyncOutcome.PRIVACY_LOCAL
    try:
        data = await HubProxy.call("GET", HUB_ENTITY_TYPE, action=HUB_ACTION, strict=True, quiet=True)
    except HubError as e:
        if e.kind == HubFailureKind.SIGNED_OUT:
            return SyncOutcome.SIGNED_OUT
        if e.kind != HubFailureKind.REJECTED or e.status_code not in _NO_SUCH_ACTION_STATUSES:
            return SyncOutcome.KEPT  # offline / server_error / not_configured / a refusal that is not "no such action"
        # The hub answered and has no such action: an older hub, which reports nothing.
        changed = _store(None)
        if changed:
            await _announce(None)
        return SyncOutcome.UNSUPPORTED
    raw = data.get("sentry_info") if isinstance(data, dict) else None
    info = parse_sentry_info(raw)
    changed = _store(info)
    if changed:
        await _announce(info)
    if info is None:
        return SyncOutcome.CLEARED
    return SyncOutcome.UPDATED if changed else SyncOutcome.UNCHANGED


async def sync_sentry_info_from_hub() -> SyncOutcome:
    """Re-read the value from the hub. Never raises; concurrent callers share one hub read.

    Sequential callers each ask the hub: the trigger is open to the browser and every worker on the box
    (that is why there is no write endpoint), and the only rate limit is the hub's own throttle on the
    triggers it sends. A minimum interval here would be a new throttle; it is deliberately not added.
    """
    key = (get_instance_settings().instance_name, id(asyncio.get_running_loop()))
    pending = _inflight.get(key)
    if pending is None:

        async def _guarded() -> SyncOutcome:
            try:
                return await _sync_once()
            except Exception:  # noqa: BLE001 -- telemetry config must never fail its caller
                logger.warning("sentry_info: sync failed", exc_info=True)
                return SyncOutcome.KEPT

        pending = asyncio.ensure_future(_guarded())
        _inflight[key] = pending
        pending.add_done_callback(lambda done: _inflight.pop(key, None) if _inflight.get(key) is done else None)
    return await asyncio.shield(pending)


def reset_cache() -> None:
    """For tests, which move instance dirs under the module's feet."""
    _cache.clear()
