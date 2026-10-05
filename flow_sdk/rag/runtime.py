"""Whether the vector index's native code can load on this machine — and, on Windows, getting it to.

usearch is C++. Its compiled module links ``MSVCP140.dll`` (the Microsoft Visual C++ Runtime),
which Python does not bundle and a clean Windows install does not ship. Most machines have it
because some other program installed it; a fresh one does not, and there ``import usearch``
raises ``ImportError: DLL load failed``. Only search needs usearch, so only search asks for it —
the rest of Flowpad never imports it (``test_server_starts_without_usearch``).

**First, without asking anyone.** ``use_app_local_runtime`` puts a ``msvcp140.dll`` that Flowpad ships
(``rag/vcruntime/``) on the loader's search path, so search works with nothing installed and no Windows permission
prompt. It is only a FALLBACK — after a normal ``import usearch`` already failed — so a machine that has the
redistributable keeps using its own copy, which Windows Update patches.

**Asked once, when there is work.** Only if that was not enough: The pass calls ``ensure`` right before it would load the
index, so a person who never turns search on is never asked — it is deliberately not part of
first-run setup. ``ensure`` does not run anything itself: it announces ``rag.runtime.missing``
(``rag_on_tag``), and the ``install-vcredist`` wizard's own trigger answers it — an ask op, then a
winget install, with an agent fallback. Once installed, the next pass finds the runtime and runs.

**A "no" parks search until a person acts.** The pass runs on a heartbeat; without the park, a
declined question would be asked again every tick. ``forget_answer`` lifts it, and is called
from the actions a person takes to make search run: adding a folder, or "index now".
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import sysconfig
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

#: The C++ runtime DLL usearch links, for each Windows architecture a Python can be. Pinned: a file that does not
#: match is never put on the search path. See ``rag/vcruntime/README.md`` for where the bytes come from.
_VCRUNTIME_DIR = Path(__file__).parent / "vcruntime"
_VCRUNTIME_SHA256 = {
    "win-amd64": "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9",
    "win-arm64": "045faeab0b5710816ae160ea20dae8495ffc11bb51feca15d22aaf7ff3752cb3",
}

#: The handle ``os.add_dll_directory`` returned. Kept: the directory is unregistered when it is closed or collected.
_dll_directory = None

MISSING_RUNTIME = "search needs the Microsoft Visual C++ Runtime, which isn't installed on this computer"

#: Set when ``ensure`` ended without a loadable index (declined, failed, or nothing to ask).
_parked = False


def app_local_runtime_dir() -> Optional[Path]:
    """The folder with the shipped ``msvcp140.dll`` for THIS interpreter, or ``None``.

    ``None`` off Windows, for an architecture nothing is shipped for (32-bit), and for a file whose SHA-256 is not
    the pinned one — a replaced DLL is not something to load into the process.
    """
    if sys.platform != "win32":
        return None
    platform = sysconfig.get_platform()
    expected = _VCRUNTIME_SHA256.get(platform)
    dll = _VCRUNTIME_DIR / platform / "msvcp140.dll"
    if expected is None or not dll.is_file():
        return None
    if hashlib.sha256(dll.read_bytes()).hexdigest() != expected:
        logger.warning("search: %s does not match its pinned SHA-256; not using it", dll)
        return None
    return dll.parent


def use_app_local_runtime() -> bool:
    """Make the shipped ``msvcp140.dll`` visible to the loader. True when it is (now) registered.

    Call it AFTER a plain ``import usearch`` failed, never before: where the redistributable is installed its own,
    patched copy is the right one. Idempotent. ``os.add_dll_directory`` is what CPython consults for the dependencies
    of an extension module, so one call covers every later import of usearch in this process.
    """
    global _dll_directory
    if _dll_directory is not None:
        return True
    folder = app_local_runtime_dir()
    if folder is None:
        return False
    try:
        _dll_directory = os.add_dll_directory(str(folder))
    except (AttributeError, OSError):  # not Windows, or a Python that predates it
        logger.warning("search: could not register %s as a DLL directory", folder, exc_info=True)
        return False
    return True


def import_usearch() -> None:
    """``import usearch.index``; on Windows, when the C++ runtime is missing, once more with the copy Flowpad ships.

    Raises the ``ImportError`` when neither works. A failed import leaves nothing in ``sys.modules``, so the retry is
    a real second attempt.
    """
    try:
        import usearch.index  # noqa: F401, PLC0415
    except ImportError:
        if not use_app_local_runtime():
            raise
        import usearch.index  # noqa: F401, PLC0415


def refusal() -> str:
    """Why search cannot run on this machine, or ``""`` when it can.

    Imports for real rather than looking for the DLL: the import is the thing that has to work,
    and a failed one leaves nothing behind in ``sys.modules``, so it is safe to try again after
    an install.
    """
    try:
        import_usearch()
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


__all__ = [
    "MISSING_RUNTIME",
    "app_local_runtime_dir",
    "ensure",
    "forget_answer",
    "import_usearch",
    "parked",
    "refusal",
    "use_app_local_runtime",
]
