"""``kernel(piece)`` — the one "which implementation" switch (spec §0 Selector).

Resolution: env ``FLOWPAD_DISKIO_BACKEND`` > preference
``advanced.diskio_backend`` > ``"python"``. A backend other than Python is
fail-open: when it is not registered for the piece, fails to load, or was built
for another ``CONTRACT_VERSION``, ONE warning is logged for the process and the
Python backend answers.

A backend joins through :func:`register` — ``{piece: {"python": factory,
"rust": factory}}``. Both are registered at the bottom of this module; a load that
fails once is not tried again in this process.
"""

from __future__ import annotations

import importlib
import logging
import os
from typing import Any, Callable, TypeVar

from flow_sdk.diskio import contract

logger = logging.getLogger(__name__)

ENV_DISKIO_BACKEND = "FLOWPAD_DISKIO_BACKEND"
PREF_DISKIO_BACKEND = "preferences.advanced.diskio_backend"
PYTHON = "python"
RUST = "rust"

P = TypeVar("P")
Factory = Callable[[], Any]

_FACTORIES: dict[type, dict[str, Factory]] = {}
_INSTANCES: dict[tuple[type, str], Any] = {}
#: (piece, backend) pairs whose load failed — never retried, so a missing binary costs
#: one lookup per process, not one per scan. ``register`` clears the pair.
_UNAVAILABLE: set[tuple[type, str]] = set()
_warned = False


def register(piece: type, backend: str, factory: Factory) -> None:
    """Bind ``factory`` as the ``backend`` implementation of Protocol ``piece``.

    The factory runs on first use and its result is kept for the process. A
    backend other than Python may expose ``CONTRACT_VERSION`` on what it
    returns; a value that differs from the contract's fails open.
    """
    _FACTORIES.setdefault(piece, {})[backend] = factory
    _INSTANCES.pop((piece, backend), None)
    _UNAVAILABLE.discard((piece, backend))


def selected_backend() -> str:
    """The backend NAME asked for — before fail-open decides what answers."""
    raw = os.environ.get(ENV_DISKIO_BACKEND, "").strip()
    if not raw:
        from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

        raw = str(read_instance_pref(PREF_DISKIO_BACKEND, PYTHON)).strip()
    return raw.lower() or PYTHON


def kernel(piece: type[P]) -> P:
    """Return the backend instance implementing Protocol ``piece``."""
    if piece not in _FACTORIES:
        raise KeyError(f"{getattr(piece, '__name__', piece)!r} is not a diskio piece")
    backend = selected_backend()
    if backend != PYTHON:
        impl = _load_other(piece, backend)
        if impl is not None:
            return impl
    return python_backend(piece)


def python_backend(piece: type[P]) -> P:
    """The Python implementation of ``piece`` — what every other backend falls back to."""
    return _instance(piece, PYTHON)


def _instance(piece: type, backend: str) -> Any:
    key = (piece, backend)
    if key not in _INSTANCES:
        _INSTANCES[key] = _FACTORIES[piece][backend]()
    return _INSTANCES[key]


def _load_other(piece: type, backend: str) -> Any | None:
    """The non-Python backend for ``piece``, or None when Python must answer."""
    key = (piece, backend)
    if key in _UNAVAILABLE:
        return None
    reason = None
    if backend not in _FACTORIES[piece]:
        reason = f"no {backend!r} backend is registered for {piece.__name__}"
    else:
        try:
            impl = _instance(piece, backend)
            built_for = getattr(impl, "CONTRACT_VERSION", contract.CONTRACT_VERSION)
            if built_for == contract.CONTRACT_VERSION:
                return impl
            reason = (f"{piece.__name__} was built for contract {built_for}, "
                      f"this wheel is {contract.CONTRACT_VERSION}")
        except Exception as exc:  # noqa: BLE001 — any load failure fails open
            reason = f"{piece.__name__} failed to load: {exc}"
    _UNAVAILABLE.add(key)
    _fail_open(backend, reason)
    return None


def _fail_open(backend: str, reason: str) -> None:
    global _warned
    if _warned:
        return
    _warned = True
    logger.warning("diskio backend %r is unavailable (%s); using the Python backend", backend, reason)


def _lazy(module: str, name: str) -> Factory:
    def factory() -> Any:
        return getattr(importlib.import_module(f"flow_sdk.diskio.{module}"), name)()

    return factory


for _piece, _module, _name in (
    (contract.TreeWalker, "tree_walker", "PyTreeWalker"),
    (contract.DeclaredScanner, "declared_scanner", "PyDeclaredScanner"),
    (contract.Scanner, "scanner", "PyScanner"),
    (contract.DocumentReader, "document_reader", "PyDocumentReader"),
    (contract.TextExtractor, "text_extractor", "PyTextExtractor"),
    (contract.Prober, "prober", "PyProber"),
    (contract.ShadowStore, "shadow_store", "PyShadowStore"),
    (contract.SessionReader, "session_reader", "PySessionReader"),
    (contract.TreeHasher, "tree_hasher", "PyTreeHasher"),
):
    register(_piece, PYTHON, _lazy(f"python.{_module}", _name))


register(contract.Scanner, RUST, _lazy("rust.scan", "RustScanner"))
