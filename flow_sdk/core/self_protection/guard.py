"""The kill guard every FlowPad kill path consults.

``partition_kill`` splits a set of target pids into those that may be killed and
those refused because they are live protected FlowPad processes. This is how the
invariant is kept for our own code: 'may clean up, must not suicide'. A
name-based "kill python" is resolved by pid here, so the backend (which shares
the ``python`` image) is spared while the user's stuck python is not.

Enforcement is behind a flag for staged rollout. When disabled, the guard is a
no-op (every target allowed) so behaviour is byte-identical to today.
"""
from __future__ import annotations

import logging
import os

from . import registry

logger = logging.getLogger(__name__)

_FLAG = "FLOWPAD_SELF_PROTECTION"
_TRUTHY = {"1", "true", "on", "yes"}


def enabled() -> bool:
    return os.environ.get(_FLAG, "").strip().lower() in _TRUTHY


def caller_is_worker() -> bool:
    """True when this process is an agentic worker (it carries an execution scope).

    An app-level signal, NOT a boundary: a worker can unset the variable, which is
    exactly why the real boundary for the worker is OS containment (L1). Here it
    cleanly tells a human/monitor/CI lifecycle action (no scope) from a worker's.
    """
    return bool(os.environ.get("FLOWPAD_EXECUTION_SCOPE", "").strip())


def authorize_lifecycle(pids, reason: str) -> bool:
    """Gate a legitimate lifecycle kill (stop / restart / upgrade) of protected pids.

    Returns whether the operation may proceed. When enforcement is off, always
    True (behaviour unchanged). A worker is refused — it must not stop or restart
    the backend it runs under. A non-worker (human, monitor, CI) is authorized,
    and the named pids are released so the downstream guarded kill can reap them.
    """
    if not enabled():
        return True
    if caller_is_worker():
        logger.warning("[self_protection] refusing lifecycle kill from a worker (%s)", reason)
        return False
    for pid in pids:
        registry.release(int(pid), reason)
    return True


def partition_kill(pids) -> tuple[list[int], list[int]]:
    """``(allowed, refused)``. ``refused`` = live protected processes."""
    pids = list(dict.fromkeys(int(p) for p in pids))  # de-dup, keep order
    if not enabled():
        return pids, []
    protected = registry.protected_pids()
    allowed = [p for p in pids if p not in protected]
    refused = [p for p in pids if p in protected]
    return allowed, refused
