"""THE rule for "this web app is up on this machine". Nothing else decides it (``tests/unit/test_one_ready_rule.py``).

Two depths, one rule:

* ``quick`` — the warm question an open asks of an app its record says is up: every process Flowpad started is
  still that process, every recorded port answers its health path, and no page failure is open. No process
  table, no tree, no write. A stranger that took a dead server's port fails it (the pid is gone).
* ``ready`` — the full answer: every process is the app's and on its port (``webapp_setup``'s ownership rule,
  read live from the process table), its health answers, its ``setup/start_app.py check`` holds; a static app is
  up once its files are placed.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.webapp_lifecycle_spec import (
    FailurePhase,
    LifecycleState,
    WebappFailureSpec,
    WebappLifecycleSpec,
)


@dataclass(frozen=True)
class Verdict:
    ok: bool
    detail: str = ""
    failure: Optional[WebappFailureSpec] = None


def _page_open(rec: WebappLifecycleSpec) -> bool:
    return rec.failure is not None and rec.failure.phase is FailurePhase.PAGE


def _pid_alive(pid: int) -> bool:
    import psutil  # noqa: PLC0415

    try:
        proc = psutil.Process(int(pid))
        return proc.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError):
        return False


async def quick(app: Any, rec: WebappLifecycleSpec) -> bool:
    """The record says up, and that still holds — cheaply (see module doc)."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415

    if rec.state is not LifecycleState.UP or _page_open(rec):
        return False
    processes = webapp_setup._processes(app)
    if not processes:
        return True  # files Flowpad serves itself: up while placed (``ready`` checks the placement)
    if any(name not in rec.ports for name in (p.name for p in processes)):
        return False
    if any(not _pid_alive(pid) for pid in rec.pids.values() if pid):
        return False
    probes = [asyncio.to_thread(webapp_setup._health_ok, rec.ports[p.name], p.serving) for p in processes]
    return all(await asyncio.gather(*probes))


async def ready(app: Any, *, display: str = "") -> Verdict:
    """The full answer, read live (see module doc). Changes nothing."""
    from flow_sdk.builtin import webapp_setup  # noqa: PLC0415
    from flow_sdk.core.webapp.failure import of_step  # noqa: PLC0415

    answer = await webapp_setup.step(str(app.id), webapp_setup.UP, check=True, display=display)
    if not answer.ok:
        return Verdict(False, answer.detail, of_step(answer.value))
    processes = webapp_setup._processes(app)
    if processes and app.asset_ref:
        port = await webapp_setup.where(app, processes[-1].serving)
        if port.state == "running" and not await asyncio.to_thread(
                webapp_setup.start_app_check, Path(app.asset_ref), int(port.port)):
            return Verdict(False, "setup/start_app.py check does not hold")
    return Verdict(True, answer.detail)


__all__ = ["Verdict", "quick", "ready"]
