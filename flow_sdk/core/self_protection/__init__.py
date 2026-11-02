"""Self-protection (FLOWPAD-2112): a live FlowPad activity is never killed or
disrupted by another FlowPad activity. 'may clean up, must not suicide'.

Public surface:
- ``register(role)`` / ``release(pid, reason)`` — maintain the protected-set.
- ``is_protected(pid)`` / ``protected_pids()`` — query it.
- ``partition_kill(pids)`` — split a kill request into (allowed, refused); the
  one call every kill path makes.
- ``enabled()`` — whether enforcement is on (flag ``FLOWPAD_SELF_PROTECTION``).

This package is the in-code guard (L0/L3/L4). The OS boundary that contains the
non-compliant worker (L1) is separate; see ``docs/self-protection.md``.
"""
from __future__ import annotations

from .guard import authorize_lifecycle, caller_is_worker, enabled, partition_kill
from .registry import is_protected, protected_pids, register, release
from .spec import ProtectedProcessSpec, ProtectedRole

__all__ = [
    "ProtectedProcessSpec",
    "ProtectedRole",
    "authorize_lifecycle",
    "caller_is_worker",
    "enabled",
    "is_protected",
    "partition_kill",
    "protected_pids",
    "register",
    "release",
]
