"""A local agent deployment's process: started, found alive again, stopped.

A running local deployment IS a subprocess on this machine running the agent loop
(``python -m flow_sdk.builtin.agent_loop``, or the deployment's own ``snippet``). It is plain SDK
code in the same instance: it inherits this process's environment — ``FLOW_INSTANCE`` above all —
and is told which deployment it is by ``FLOW_DEPLOYMENT_ID``.

The process is recorded on the deployment row as the ``ProcRef`` ``spawn_detached`` returned
(``provider_labels``), so a restarted app finds it alive again instead of starting a twin, and a
recycled pid is never mistaken for it (``create_time`` pins the identity, as ``instances/procs`` does).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

from flow_sdk.instances.model import ProcRef

#: The environment variable that tells the loop which deployment it runs.
DEPLOYMENT_ENV = "FLOW_DEPLOYMENT_ID"

#: ``provider_labels`` key → ``ProcRef`` field. Labels are strings; ``ProcRef.from_json`` parses them.
_LABELS = {f"flowpad.process.{f}": f for f in ("pid", "pgid", "create_time", "log")}


def _log_path(deployment) -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().logs_dir) / "deployments" / f"{deployment.id}.log"


def _argv(deployment) -> list[str]:
    snippet = str(getattr(deployment, "snippet", "") or "").strip()
    return [sys.executable, snippet] if snippet else [sys.executable, "-m", "flow_sdk.builtin.agent_loop"]


def recorded(deployment) -> ProcRef:
    """The process recorded on *deployment* (every field ``None`` when none is)."""
    labels = dict(getattr(deployment, "provider_labels", None) or {})
    return ProcRef.from_json({field: labels.get(key) or None for key, field in _LABELS.items()})


def labels_of(ref: Optional[ProcRef]) -> dict[str, str]:
    """The ``provider_labels`` that record *ref* — or, for ``None``, that no process is running
    (its log is kept: it is still where the last run wrote)."""
    values = ref.to_json() if ref is not None else {}
    return {key: str(values.get(field) or "") for key, field in _LABELS.items() if ref is not None or field != "log"}


def _process(deployment):
    """The live ``psutil.Process`` recorded on *deployment*, or ``None``: gone, a zombie, or a
    recycled pid (no start time recorded, or a different one)."""
    import psutil  # noqa: PLC0415

    ref = recorded(deployment)
    if ref.pid is None or ref.create_time is None:
        return None
    try:
        proc = psutil.Process(ref.pid)
        if proc.status() == psutil.STATUS_ZOMBIE or abs(proc.create_time() - ref.create_time) > 1.0:
            return None
        return proc
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def alive(deployment) -> bool:
    """Whether the process recorded on *deployment* is running — the same process, not a recycled pid."""
    return _process(deployment) is not None


def start(deployment) -> dict[str, str]:
    """Start the deployment's loop process; the labels that record it (written by the caller)."""
    from flow_sdk.instances.procs import spawn_detached  # noqa: PLC0415

    env = {**os.environ, DEPLOYMENT_ENV: str(deployment.id)}
    return labels_of(spawn_detached(_argv(deployment), env=env, log=_log_path(deployment), cwd=Path.cwd()))


def stop(deployment) -> bool:
    """Stop the recorded process and every process under it; whether none of them is left running."""
    from flow_sdk.instances.procs import terminate_tree  # noqa: PLC0415

    proc = _process(deployment)
    return proc is None or not terminate_tree([proc])[1]


__all__ = ["DEPLOYMENT_ENV", "alive", "labels_of", "recorded", "start", "stop"]
