"""The backends the conformance kit runs each piece against.

Each test module parametrizes over ``backends(<Protocol>)`` and instantiates
the class DIRECTLY — never through ``kernel()``, whose fail-open would turn a
Rust-vs-Python comparison into Python-vs-Python and pass. A Rust backend is
enrolled in ``_RUST`` when its binary is present, and its piece's tests then run
against both.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.diskio import contract
from flow_sdk.diskio.python.declared_scanner import PyDeclaredScanner
from flow_sdk.diskio.python.document_reader import PyDocumentReader
from flow_sdk.diskio.python.prober import PyProber
from flow_sdk.diskio.python.scanner import PyScanner
from flow_sdk.diskio.python.session_reader import PySessionReader
from flow_sdk.diskio.python.shadow_store import PyShadowStore
from flow_sdk.diskio.python.text_extractor import PyTextExtractor
from flow_sdk.diskio.python.tree_hasher import PyTreeHasher
from flow_sdk.diskio.python.tree_walker import PyTreeWalker

_PYTHON: dict[type, type] = {
    contract.TreeWalker: PyTreeWalker,
    contract.DeclaredScanner: PyDeclaredScanner,
    contract.Scanner: PyScanner,
    contract.DocumentReader: PyDocumentReader,
    contract.TextExtractor: PyTextExtractor,
    contract.Prober: PyProber,
    contract.ShadowStore: PyShadowStore,
    contract.SessionReader: PySessionReader,
    contract.TreeHasher: PyTreeHasher,
}
_RUST: dict[type, type] = {}

# The one Rust piece: enrolled only when its binary is present (a vendored copy, a
# source-checkout build, or FLOWPAD_DISKIO_SCAN_BIN) — absent, the kit runs Python only.
from flow_sdk.diskio.rust.scan import RustScanner, scan_binary_path  # noqa: E402

if scan_binary_path() is not None:
    _RUST[contract.Scanner] = RustScanner


def backends(piece: type) -> list:
    """``pytest.param`` per backend class implementing ``piece``."""
    params = [pytest.param(_PYTHON[piece], id="python")]
    if piece in _RUST:
        params.append(pytest.param(_RUST[piece], id="rust"))
    return params


def touch(path: Path, text: str = "x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def drain(stream) -> tuple[list, contract.StreamEnd]:
    """A backend stream as ``(items, terminal)``; the terminal must be the one
    ``StreamEnd``, last, and its counts must equal what was yielded."""
    items = list(stream)
    assert items and isinstance(items[-1], contract.StreamEnd), "a stream ends with StreamEnd"
    *body, end = items
    assert not any(isinstance(item, contract.StreamEnd) for item in body), "exactly one StreamEnd"
    counted: dict[str, int] = {}
    for item in body:
        counted[type(item).spec_kind] = counted.get(type(item).spec_kind, 0) + 1
    assert {kind: n for kind, n in end.counts.items() if n} == counted
    return body, end
