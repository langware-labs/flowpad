"""TimeIt — lightweight step-by-step timing utility.

Usage::

    from flow_sdk.utils import TimeIt

    t = TimeIt("Bootstrap")
    await init_db()
    t.time("init_db")
    await setup()
    t.time("setup")
    t.done(0.5)  # prints report only if total > 500ms
"""

from __future__ import annotations

import logging
import time

log = logging.getLogger(__name__)


class TimeIt:
    """Records elapsed time for named steps and prints a report on threshold breach.

    Example::

        t = TimeIt("Bootstrap")
        do_step_a()
        t.time("step_a")
        do_step_b()
        t.time("step_b")
        t.done(0.5)   # prints if total > 500ms
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self._steps: list[tuple[str, float]] = []  # (label, duration_ms)
        self._last = time.perf_counter()
        self._start = self._last

    def time(self, label: str) -> float:
        """Record elapsed ms since last call (or construction). Returns ms elapsed."""
        now = time.perf_counter()
        ms = (now - self._last) * 1000
        self._steps.append((label, ms))
        self._last = now
        return ms

    def done(self, threshold: float = 0.5) -> None:
        """Print report if total elapsed exceeds *threshold* seconds."""
        total_ms = (time.perf_counter() - self._start) * 1000
        if total_ms < threshold * 1000:
            return
        width = max((len(label) for label, _ in self._steps), default=20) + 2
        lines = [f"\n{'─' * (width + 12)}"]
        lines.append(f"  {self.name} slowness detected ({total_ms:.0f}ms > {threshold * 1000:.0f}ms threshold)")
        lines.append(f"{'─' * (width + 12)}")
        for label, ms in self._steps:
            bar = "█" * min(int(ms / 10), 40)
            lines.append(f"  {label:<{width}} {ms:>7.1f}ms  {bar}")
        lines.append(f"{'─' * (width + 12)}")
        lines.append(f"  {'TOTAL':<{width}} {total_ms:>7.1f}ms")
        lines.append(f"{'─' * (width + 12)}\n")
        log.warning("\n".join(lines))
