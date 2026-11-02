"""The protected-set on disk: ``<instance_dir>/runtime/<role>-<pid>.json``.

DISCOVERY, not a boundary — it only answers "is this a live protected FlowPad
process". The OS boundary (worker containment) is what stops the one actor that
will not consult a guard. The worker never reads or writes this directory in its
normal flow; forging a file here cannot move the OS boundary.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from .spec import ProtectedProcessSpec, ProtectedRole

logger = logging.getLogger(__name__)


def _runtime_dir() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "runtime"


def _path_for(role: ProtectedRole, pid: int) -> Path:
    return _runtime_dir() / f"{role.value}-{pid}.json"


def _create_time(pid: int) -> float | None:
    """A process's start time as psutil reports it, or None if it is not live."""
    try:
        import psutil  # noqa: PLC0415

        return psutil.Process(pid).create_time()
    except Exception:
        return None


def register(role: ProtectedRole, pid: int | None = None) -> ProtectedProcessSpec:
    """Record a live process as protected. Called by each protected process at startup."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    pid = os.getpid() if pid is None else pid
    ct = _create_time(pid)
    if ct is None:
        raise RuntimeError(f"self_protection.register: pid {pid} is not live")
    spec = ProtectedProcessSpec(
        role=role,
        pid=pid,
        create_time=ct,
        instance=get_instance_settings().instance_name,
        registered_at=time.time(),
    )
    d = _runtime_dir()
    d.mkdir(parents=True, exist_ok=True)
    _path_for(role, pid).write_text(spec.model_dump_json(), encoding="utf-8")
    logger.info("[self_protection] registered %s pid=%s", role.value, pid)
    return spec


def release(pid: int, reason: str) -> None:
    """Drop protection for ``pid`` (the lifecycle supervisor, before a real restart)."""
    removed = False
    for p in _runtime_dir().glob(f"*-{pid}.json"):
        p.unlink(missing_ok=True)
        removed = True
    if removed:
        logger.info("[self_protection] released pid=%s (%s)", pid, reason)


def _entries() -> list[ProtectedProcessSpec]:
    out: list[ProtectedProcessSpec] = []
    try:
        files = list(_runtime_dir().glob("*.json"))
    except Exception:
        return out
    for f in files:
        try:
            out.append(ProtectedProcessSpec.model_validate_json(f.read_text(encoding="utf-8")))
        except Exception:
            logger.debug("[self_protection] skipping unreadable registry file %s", f, exc_info=True)
    return out


def protected_pids() -> set[int]:
    """Every pid that is registered AND still the same live process.

    The create_time recheck closes the race where the protected pid died and its
    number was reused by something we would otherwise be allowed to kill; a stale
    entry is pruned.
    """
    live: set[int] = set()
    for spec in _entries():
        if _create_time(spec.pid) == spec.create_time:
            live.add(spec.pid)
        else:
            _path_for(spec.role, spec.pid).unlink(missing_ok=True)
    return live


def is_protected(pid: int) -> bool:
    return pid in protected_pids()
