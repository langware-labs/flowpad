"""ADJUSTABLE_TIMEOUT: seconds a RUNNER adds to every fixed test timeout. Default 0 = the committed values, unchanged.

The fixed caps (``--timeout=30`` in pytest.ini, every ``@pytest.mark.timeout(N)``, the readiness budgets that wrap
``adjusted(...)``) were measured on a fast machine. A slower host - a cloud VM, a sandbox that boots the server in ~30 s -
sets ``ADJUSTABLE_TIMEOUT=10`` in ITS environment, and every cap grows by 10 s. Never edit a cap in a test for that:
the number in the test stays the fast-machine truth; the slack belongs to the environment that needs it.
"""
from __future__ import annotations

import os


def _read() -> float:
    try:
        return max(0.0, float(os.environ.get("ADJUSTABLE_TIMEOUT", "0") or 0))
    except ValueError:
        return 0.0


ADJUSTABLE_TIMEOUT: float = _read()


def adjusted(seconds: float) -> float:
    """``seconds`` plus this runner's ADJUSTABLE_TIMEOUT. A budget of 0 (no limit) stays 0."""
    return seconds + ADJUSTABLE_TIMEOUT if seconds else seconds
