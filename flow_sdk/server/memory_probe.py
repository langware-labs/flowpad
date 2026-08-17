"""One-line system memory probe, for recording what the machine looked like at
the moment something went wrong.

The watchdog used to log only the server process's own RSS, once every ten
minutes. That number cannot show the condition that actually stalls a box — the
MACHINE running out of memory while other processes (npm, agent CLIs) eat it —
so a stall investigated after the fact had no measurement to consult and the
cause stayed a hypothesis. This probe is that missing measurement.

Two properties matter at the call sites:

* **It never raises.** Every caller is already handling a degraded system; a
  probe that throws would turn a diagnosable stall into a crash.
* **It is cheap when it needs to be.** ``top_n=0`` skips the process walk, so
  the periodic heartbeat line can carry the totals without paying for a full
  scan every ten minutes.
"""

from __future__ import annotations

_MB = 1024 * 1024


def memory_snapshot(top_n: int = 5) -> str:
    """Return a compact one-line system memory summary. Never raises.

    Example::

        mem 450MB avail / 1982MB (77% used) | swap 0MB free / 0MB |
        top RSS: claude=377MB claude=349MB python3.10=275MB

    Args:
        top_n: How many processes to name, largest resident set first. Pass 0
               to report only the totals and skip the process walk.
    """
    try:
        import psutil
    except ImportError:
        return "mem unavailable (psutil missing)"

    try:
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        parts = [
            f"mem {mem.available // _MB}MB avail / {mem.total // _MB}MB ({mem.percent:.0f}% used)",
            f"swap {swap.free // _MB}MB free / {swap.total // _MB}MB",
        ]
    except Exception:  # noqa: BLE001 - a forensic probe must never break its caller
        return "mem unavailable (probe failed)"

    if top_n > 0:
        try:
            procs: list[tuple[int, str]] = []
            for proc in psutil.process_iter(["name", "memory_info"]):
                rss = getattr(proc.info.get("memory_info"), "rss", 0)
                if rss:
                    procs.append((rss, proc.info.get("name") or "?"))
            procs.sort(reverse=True)
            if procs:
                top = " ".join(f"{name}={rss // _MB}MB" for rss, name in procs[:top_n])
                parts.append(f"top RSS: {top}")
        except Exception:  # noqa: BLE001
            parts.append("top RSS: unavailable")

    return " | ".join(parts)
