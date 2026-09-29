"""Whether the vector index's native code can load on this machine — and, on Windows, getting it to.

usearch is C++. Its compiled module links ``MSVCP140.dll`` (the Microsoft Visual C++ Runtime),
which Python does not bundle and a clean Windows install does not ship. Most machines have it
because some other program installed it; a fresh one does not, and there ``import usearch``
raises ``ImportError: DLL load failed``. Only search needs usearch, so only search asks for it —
the rest of Flowpad never imports it (``test_server_starts_without_usearch``).

**Asked once, when there is work.** The pass calls ``ensure`` right before it would load the
index, so a person who never turns search on is never asked — it is deliberately not part of
first-run setup. ``ensure`` does not run anything itself: it announces ``rag.runtime.missing``
(``rag_on_tag``), and the ``install-vcredist`` wizard's own trigger answers it — an ask op, then a
winget install, with an agent fallback. Once installed, the next pass finds the runtime and runs.

**A "no" parks search until a person acts.** The pass runs on a heartbeat; without the park, a
declined question would be asked again every tick. ``forget_answer`` lifts it, and is called
from the actions a person takes to make search run: adding a folder, or "index now".
"""

from __future__ import annotations

import logging
import sys

logger = logging.getLogger(__name__)

MISSING_RUNTIME = "search needs the Microsoft Visual C++ Runtime, which isn't installed on this computer"

#: Set when ``ensure`` ended without a loadable index (declined, failed, or nothing to ask).
_parked = False


def refusal() -> str:
    """Why search cannot run on this machine, or ``""`` when it can.

    Imports for real rather than looking for the DLL: the import is the thing that has to work,
    and a failed one leaves nothing behind in ``sys.modules``, so it is safe to try again after
    an install.
    """
    try:
        import usearch.index  # noqa: F401, PLC0415
    except ImportError as exc:
        if sys.platform == "win32":
            return MISSING_RUNTIME
        return f"search's vector index could not load: {exc}"
    return ""


async def ensure(index_id: str) -> str:
    """Why *index_id*'s pass cannot load its index, or ``""``. On Windows, asks for the runtime.

    Asks at most once until a person acts (``forget_answer``): the first miss announces
    ``rag.runtime.missing`` and parks, so the heartbeat does not ask again every tick. Never
    raises; the caller records the returned reason on the row.
    """
    global _parked

    reason = refusal()
    if not reason or _parked or sys.platform != "win32":
        _parked = bool(reason)
        return reason

    from flow_sdk.rag.rag_on_tag import emit_runtime_missing  # noqa: PLC0415

    emit_runtime_missing(index_id, reason)
    _parked = True
    return reason


def parked() -> bool:
    """True while a missing runtime was already asked about and is still missing."""
    return _parked and bool(refusal())


def forget_answer() -> None:
    """A person asked for search to run: ask again the next time the runtime is found missing."""
    global _parked
    _parked = False


__all__ = ["MISSING_RUNTIME", "ensure", "forget_answer", "parked", "refusal"]
