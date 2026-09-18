"""One-shot worker naming: read provider evidence, reconcile, never subscribe.

Names move on two kinds of edge only. A transcript event delivered by the
transcript streamer (``AgenticProcess._flush_transcript_change``) applies
:func:`apply_transcript_names`; a lifecycle edge (open, resume, first prompt,
session adoption) calls :func:`refresh_process_name`.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

_log = logging.getLogger(__name__)


def _adapter(process):
    """The process's naming adapter, or None when names are not read locally."""
    if process.hub_route:
        return None
    driver = process._restart_driver()
    return driver.naming_adapter if driver is not None else None


async def refresh_process_name(process, *, first_prompt: str | None = None):
    """Read/reconcile one process once. Missing observations retain its last name."""
    from .service import reconcile_name

    if process.hub_route:
        return process
    migration = ()
    adapter = _adapter(process)
    if adapter is not None and (process.naming_state is None or process.naming_state.session_id != process.session_id):
        migration = await asyncio.to_thread(adapter.read, process)
    result = await reconcile_name(str(process.id), first_prompt=first_prompt,
                                  migration_observations=migration)
    current = result.process
    if current is None:
        return None
    adapter = _adapter(current)
    if adapter is None:
        return current
    # PTY harnesses mint their native identity after launch.
    if not current.session_id and await current.adopt_discovered_session():
        return await refresh_process_name(current, first_prompt=first_prompt)
    if current.session_id and not first_prompt and not current.naming_state.fallback:
        from flow_sdk.builtin.worker_history import _normalize_worker_type, _worker_first_prompt_sync

        def initial_prompt():
            path = current.transcript_path
            return _worker_first_prompt_sync(_normalize_worker_type(current.worker_type), path) if path else None

        prompt = await asyncio.to_thread(initial_prompt)
        if prompt:
            result = await reconcile_name(str(current.id), first_prompt=prompt)
            current = result.process
            if current is None:
                return None
    return await _reconcile_observations(current, adapter)


async def apply_transcript_names(process, entries: Sequence[object]):
    """Apply a delivered transcript batch to one process's name.

    The adapter decides from the entries whether the batch can carry a title;
    only then is the native store read once and reconciled.
    """
    adapter = _adapter(process)
    if adapter is None or not adapter.transcript_may_rename(entries):
        return process
    return await _reconcile_observations(process, adapter)


async def _reconcile_observations(process, adapter):
    from .service import reconcile_name

    try:
        observations = await asyncio.to_thread(adapter.read, process)
    except (OSError, ValueError):
        _log.debug("worker name unavailable for %s", process.id, exc_info=True)
        return process
    current = process
    for observation in observations:
        result = await reconcile_name(str(current.id), observation=observation)
        current = result.process
        if current is None:
            return None
    return current
