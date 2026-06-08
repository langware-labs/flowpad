"""Capability discovery engine — typed values, background sweeps, global dict.

The generic half of the capability design: a sweep goes over every registered
capability and calls its ``discover()`` hook (the only per-capability part),
storing each result as a :class:`CapabilityValue` in a module-global dict.
Workers fetch values at spawn time via :func:`get_capability_value` — e.g. the
harness CLIs' value is the bin FOLDER to prepend to the child PATH.

Sweeps run on every server start (background task — nothing blocks startup)
and on demand: the capability window's check/refresh re-runs discovery from
scratch, and the install monitor re-discovers after an install process
finishes. Each value is also mirrored onto the Capability entity row
(``value`` / ``value_type``, saved with notify) so the capabilities window
shows exactly what workers consume — alignment by construction.

The environment-sensitive part (login-shell PATH capture + which) runs in a
separate clean subprocess (``env_probe.py``) with a hard 5s cap, so a hanging
dotfile can never wedge the server.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys

from flow_sdk.core.capabilities.models import CapabilityValue

logger = logging.getLogger(__name__)

# Hard cap on the env-probe child (user-approved). The child's own shell
# capture caps at 4s, leaving headroom for python startup + which calls.
PROBE_TIMEOUT_SECONDS = 5.0

# kind → discovered value. The canonical runtime store — workers and
# capability checks read THIS; entity rows are a mirror for the UI.
_VALUES: dict[str, CapabilityValue] = {}

# Set after the first full sweep completes. Callers that need accurate values
# (e.g. bootstrap's harness state) await ``ensure_discovered`` so they don't
# read an empty dict during the startup window.
_DISCOVERED_ONCE = asyncio.Event()
_DISCOVERY_LOCK = asyncio.Lock()


def get_capability_value(kind: str) -> CapabilityValue | None:
    """The last discovered value for ``kind`` (None = never discovered)."""
    return _VALUES.get(kind)


async def ensure_discovered() -> bool:
    """Ensure at least one full discovery sweep has completed.

    No-op once a full sweep has finished. If startup already has a full sweep in
    flight, this waits for that sweep; otherwise it runs one directly.
    """
    if _DISCOVERED_ONCE.is_set():
        return True
    async with _DISCOVERY_LOCK:
        if _DISCOVERED_ONCE.is_set():
            return True
        await _run_discovery_inner(None)
        return _DISCOVERED_ONCE.is_set()


def set_capability_value(value: CapabilityValue) -> None:
    """Store a discovered value (sweeps; injectable in tests)."""
    _VALUES[value.kind] = value


async def _run_env_probe(executables: list[str]) -> dict:
    """Run the env-probe child; fall back to in-process which on failure.

    The fallback resolves against THIS process's PATH — degraded (a
    GUI-launched backend misses version-manager dirs) but never empty, and
    the sweep still completes.
    """
    if executables:
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "flow_sdk.core.capabilities.env_probe",
                *executables,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                out, err = await asyncio.wait_for(
                    proc.communicate(), timeout=PROBE_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise RuntimeError(f"env probe exceeded {PROBE_TIMEOUT_SECONDS}s")
            if proc.returncode == 0:
                return json.loads(out.decode("utf-8"))
            raise RuntimeError(
                f"env probe exited {proc.returncode}: {err.decode('utf-8', 'replace')[:200]}"
            )
        except Exception as exc:
            logger.warning("Capability env probe failed (%s) — falling back to process PATH", exc)
    return {
        "path": os.environ.get("PATH", ""),
        "executables": {exe: shutil.which(exe) for exe in executables},
        "fallback": True,
    }


async def run_discovery(kinds: list[str] | None = None) -> dict[str, CapabilityValue]:
    """Discover capability values for ``kinds`` (None = all registered).

    Two passes: concrete runners first (they produce values), then reference
    runners (they mirror their target's fresh value) — so a reference never
    reads a stale entry regardless of registry order. Results land in the
    global dict and are mirrored onto the Capability entity rows.
    """
    if kinds is None:
        async with _DISCOVERY_LOCK:
            return await _run_discovery_inner(None)
    return await _run_discovery_inner(kinds)


async def _run_discovery_inner(kinds: list[str] | None) -> dict[str, CapabilityValue]:
    from flow_sdk.core.capabilities.registry import (
        CapabilityReferenceRunner,
        CliCapabilityRunner,
        get_capability_registry,
    )

    registry = get_capability_registry()
    runners = [registry.get(k) for k in kinds] if kinds else list(registry.runners())

    # One child probe per sweep covers every CLI runner in it. References may
    # point at CLI kinds outside ``kinds`` — probe those executables too.
    cli_executables: set[str] = set()
    for runner in runners:
        if isinstance(runner, CliCapabilityRunner):
            cli_executables.add(runner.executable)
        elif isinstance(runner, CapabilityReferenceRunner):
            for candidate in registry.runners():
                if isinstance(candidate, CliCapabilityRunner):
                    cli_executables.add(candidate.executable)
    probe = await _run_env_probe(sorted(cli_executables))

    discovered: dict[str, CapabilityValue] = {}
    concrete = [r for r in runners if not isinstance(r, CapabilityReferenceRunner)]
    references = [r for r in runners if isinstance(r, CapabilityReferenceRunner)]
    for runner in concrete:
        value = await _discover_one(runner, probe)
        if value is not None:
            discovered[value.kind] = value
    for runner in references:
        # References need their (possibly out-of-sweep) target fresh first.
        target_kind = await runner.resolve_reference_kind()
        if target_kind and target_kind not in discovered:
            try:
                target = registry.get(target_kind)
            except KeyError:
                target = None
            if target is not None and not isinstance(target, CapabilityReferenceRunner):
                target_value = await _discover_one(target, probe)
                if target_value is not None:
                    discovered[target_value.kind] = target_value
        value = await _discover_one(runner, probe)
        if value is not None:
            discovered[value.kind] = value

    await _mirror_to_rows(discovered)
    if kinds is None:
        _DISCOVERED_ONCE.set()  # unblock ensure_discovered() waiters
    return discovered


async def _discover_one(runner, probe: dict) -> CapabilityValue | None:
    try:
        value: CapabilityValue = await runner.discover(probe)
    except Exception:
        logger.exception("Capability discover failed for %s", runner.spec.kind)
        return None
    set_capability_value(value)
    return value


async def _mirror_to_rows(discovered: dict[str, CapabilityValue]) -> None:
    """Write discovered values onto Capability entity rows (notify=True) so
    the capabilities window shows the same values workers consume.

    Also refresh ``last_check`` from the freshly-discovered value: the badge
    reads ``last_check``, so without this it would disagree with the value
    until a manual refresh (the alignment requirement). check() now reads the
    same discovery dict, so badge + value + actual spawn all agree.
    """
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.capabilities.registry import get_capability_registry

    registry = get_capability_registry()
    for kind, value in discovered.items():
        try:
            row = await Capability.get_by_kind(kind)
            if row is None:
                continue
            check = await registry.check(kind)
            last_check = check.result.model_dump(mode="json")
            unchanged = (
                row.value == value.value
                and row.value_type == value.value_type
                and row.last_check == last_check
            )
            if unchanged:
                continue
            row.value = value.value
            row.value_type = value.value_type
            row.last_check = last_check
            await row.save(notify=True)
        except Exception:
            logger.exception("Failed to mirror capability value for %s", kind)
