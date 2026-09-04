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


def resolve_capability_value(kind: str) -> CapabilityValue | None:
    """``kind``'s resolved value — swept, else PATH, else ``None``.

    **Never runs a sweep**, and never awaits: this is what a spawn calls, and a
    spawn must be immediate. A sweep costs seconds — an env-probe subprocess plus
    ``registry.test()`` per capability so the UI's badges stay fresh — none of
    which answers the only question here, "where is this binary".

    Resolution order:

    1. a swept value, if there is one. Authoritative — including a swept
       ``value=None``, which is a real "looked, absent".
    2. otherwise, for a CLI capability, ``shutil.which`` against this process's
       PATH. A hit is recorded, so it is probed once and never again.

    A miss is deliberately NOT recorded. The sweep resolves against a LOGIN-shell
    PATH (see ``env_probe``) so a GUI-launched backend still sees nvm/homebrew;
    this fallback only has the process PATH, so a miss here can be wrong.
    Remembering a wrong "absent" would outlive the reason for it, and would also
    remove the only way a CLI installed outside Flowpad is ever picked up. The
    re-probe costs a ``which``.

    Returns None for capabilities that are not a CLI lookup (Chrome, GitHub, the
    ``harness`` reference) — those need a real sweep and never block a spawn.
    """
    existing = _VALUES.get(kind)
    if existing is not None:
        return existing

    # Imported past the fast path: a memoized hit is then a single dict lookup,
    # and this runs a few times per spawn.
    from flow_sdk.core.capabilities.registry import CliCapabilityRunner, get_capability_registry

    try:
        runner = get_capability_registry().get(kind)
    except KeyError:
        return None
    if not isinstance(runner, CliCapabilityRunner):
        return None

    resolved = shutil.which(runner.executable)
    if not resolved:
        return None
    value = runner.value_from_executable_path(resolved, source="this process's PATH")
    set_capability_value(value)
    return value


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
                out, err = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                # The timeout fires on OUR clock, not on the child's liveness,
                # so the child is often already reaped by now — and uvloop raises
                # ProcessLookupError for a kill on a reaped process. Swallow it
                # so the RuntimeError below is what reaches the caller.
                try:
                    proc.kill()
                    await proc.wait()
                except ProcessLookupError:
                    pass
                raise RuntimeError(f"env probe exceeded {PROBE_TIMEOUT_SECONDS}s") from None
            if proc.returncode == 0:
                return json.loads(out.decode("utf-8"))
            raise RuntimeError(f"env probe exited {proc.returncode}: {err.decode('utf-8', 'replace')[:200]}")
        except Exception as exc:
            # Name the TYPE, never just str(exc). Several exceptions that land
            # here — ProcessLookupError, NotImplementedError, CancelledError —
            # carry an empty message, so this logged "failed ()" for a long time
            # and nobody could tell what had gone wrong.
            logger.warning(
                "Capability env probe failed (%s: %s) — falling back to process PATH",
                type(exc).__name__,
                exc,
            )
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
    await _resolve_login_states(discovered)
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


async def _resolve_login_states(discovered: dict[str, CapabilityValue]) -> None:
    """Ask every installed harness whether it is signed in, and mirror the verdict.

    ``Capability.login_state`` is ``Persist.FALSE`` -- ``None`` after every restart -- and
    ``llm_source._device_source`` reads exactly that field to decide whether the device rung
    is proven. ``None`` means "nobody has asked", so the rung stays eligible at
    ``_RANK_DEVICE`` and ``pick_llm_candidate`` returns it on its first pass; on an unbound
    box the ladder therefore never descends to a hub endpoint at ``_RANK_ENDPOINT``, and
    ``resolve_worker_api_auth`` hands the spawn no credentials at all.

    Until now the ONLY producer of ``login_state`` was ``Capability.auth_status_action`` --
    the login modal's button. A box whose user never opened that screen kept ``None`` for the
    life of the process, so a desktop install with a granted budget and no vendor login died
    on the vendor's own "Could not resolve authentication method" with the budget untouched.
    The sweep is where that question belongs: it already runs before any spawn resolves.

    Deliberately narrow:

    * only harness CLIs (``worker_type_for_kind``), and only ones the sweep found INSTALLED --
      a probe against a missing binary answers ``NOT_INSTALLED``, which
      ``_mirror_probe_to_login_state`` correctly refuses to write, so it is a subprocess spent
      to learn nothing;
    * concurrent, so N harnesses cost about one probe of wall clock rather than N;
    * per-harness failures are swallowed -- a vendor CLI that hangs or misbehaves must not
      take the whole capability sweep down with it.

    It writes through ``_mirror_probe_to_login_state``, the same one writer the action uses,
    so an undecided probe still moves nothing and a login in flight is still not clobbered.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.capabilities.registry import get_capability_registry

    registry = get_capability_registry()

    async def probe(kind: str, worker_type: str) -> None:
        try:
            row = await Capability.get_by_kind(kind)
            if row is None:
                return
            before = row.login_state
            await row._mirror_probe_to_login_state(await get_driver(worker_type).auth_probe())
            if row.login_state != before:
                # ``_mirror_probe_to_login_state`` writes the field and broadcasts, but does
                # NOT save -- ``notify_updated`` only publishes. ``login_state`` is
                # ``Persist.FALSE``, which means DB-only (never mirrored into
                # metadata.json), not in-memory-only; without this the verdict dies with
                # this row object and the resolver's own ``Capability.get_by_kind`` read in
                # ``llm_source._inventory`` -- a DIFFERENT instance -- still sees ``None``.
                # ``notify=False``: the mirror already emitted the frame.
                await row.save(notify=False)
        except Exception:
            logger.exception("Failed to resolve login state for %s", kind)

    installed = [
        (kind, registry.worker_type_for_kind(kind)) for kind, value in discovered.items() if value.value is not None
    ]
    await asyncio.gather(*(probe(k, w) for k, w in installed if w))


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
            check = await registry.test(kind)
            last_check = check.result.model_dump(mode="json")
            # Passive sweep (attempted=False): may flip a row to AVAILABLE or
            # back off a stale AVAILABLE, but never promotes NONE ("never
            # tried") to NOT_AVAILABLE — that takes an explicit user verb.
            state = row.derive_state(check.result)
            unchanged = (
                row.value == value.value
                and row.value_type == value.value_type
                and row.last_check == last_check
                and row.state == state
            )
            if unchanged:
                continue
            row.value = value.value
            row.value_type = value.value_type
            row.last_check = last_check
            row.state = state
            await row.save(notify=True)
        except Exception:
            logger.exception("Failed to mirror capability value for %s", kind)
