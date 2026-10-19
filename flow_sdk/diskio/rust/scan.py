"""RustScanner — the ``Scanner`` piece answered by the ``flowpad-diskio-scan`` binary.

The binary is found BEFORE anything is spawned (the shape of
``flow_rs_binary.vendored_flow_rs_path``): an explicit ``FLOWPAD_DISKIO_SCAN_BIN``,
else the vendored copy under ``flow_sdk/rust/bin/<platform>/``, else — in a source
checkout only — the crate's own ``target/release`` build. No binary means the
factory raises and ``kernel()`` fails open to Python with one warning; nothing is
spawned on a platform that ships none (Linux today).

One request goes to the child's stdin; its stdout is tagged NDJSON. This class is the
transport only: a child that cannot run, exits non-zero or writes an unreadable line is a
:class:`StreamFailure`. Whether the stream is COMPLETE (one terminal, counts that add up)
is checked once, for every backend, by ``stage1._collect``.
"""

from __future__ import annotations

import importlib.resources
import io
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Iterator

from flow_sdk.diskio.contract import (
    ScanCandidate,
    ScanProblem,
    ScanRequest,
    StreamEnd,
    WalkEntry,
)
from flow_sdk.diskio.stage1 import StreamFailure
from flow_sdk.flow_rs_binary import ensure_executable, vendored_binary_path
from flow_sdk.schema.data_spec.spec import spec_tag

logger = logging.getLogger(__name__)

ENV_SCAN_BIN = "FLOWPAD_DISKIO_SCAN_BIN"
BINARY_NAME = "flowpad-diskio-scan"

_BY_KIND = {cls.spec_kind: cls for cls in (WalkEntry, ScanCandidate, ScanProblem, StreamEnd)}


def scan_binary_path() -> Path | None:
    """Where the scan binary is, or None. Pure lookup — nothing is executed."""
    override = os.environ.get(ENV_SCAN_BIN, "").strip()
    if override:
        path = Path(override)
        return path if path.is_file() and os.access(path, os.X_OK) else None
    vendored = vendored_binary_path(BINARY_NAME)
    if vendored is not None:
        return ensure_executable(vendored)
    name = BINARY_NAME + (".exe" if sys.platform == "win32" else "")
    built = Path(str(importlib.resources.files("flow_sdk"))) / "rust" / "diskio" / "target" / "release" / name
    return built if built.is_file() and os.access(built, os.X_OK) else None


def _binary_contract_version(binary: Path) -> int:
    proc = subprocess.run([str(binary), "--contract-version"], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"{binary} --contract-version exited {proc.returncode}")
    return int(proc.stdout.strip())


class RustScanner:
    def __init__(self, binary: Path | None = None) -> None:
        found = binary if binary is not None else scan_binary_path()
        if found is None:
            raise FileNotFoundError(f"no {BINARY_NAME} binary for this platform")
        self._binary = found
        #: Read by ``kernel()``: a binary built for another contract fails open.
        self.CONTRACT_VERSION = _binary_contract_version(found)
        logger.info("diskio: the Rust scan backend is answering (%s, contract %s)", found, self.CONTRACT_VERSION)

    def scan(self, request: ScanRequest) -> Iterator[WalkEntry | ScanCandidate | ScanProblem | StreamEnd]:
        payload = json.dumps({"spec_kind": spec_tag(request), **request.model_dump(mode="json")})
        try:
            proc = subprocess.run([str(self._binary)], input=payload.encode("utf-8"),
                                  capture_output=True, check=False)
        except OSError as exc:
            raise StreamFailure(f"{self._binary} could not be run: {exc}") from exc
        if proc.returncode != 0:
            tail = proc.stderr.decode("utf-8", "replace").strip()[-300:]
            raise StreamFailure(f"{self._binary} exited {proc.returncode}: {tail}")
        for raw in io.BytesIO(proc.stdout):
            if not raw.strip():
                continue
            try:
                line = json.loads(raw)
                yield _BY_KIND[line.pop("spec_kind")].model_validate(line)
            except Exception as exc:  # noqa: BLE001 — any bad line voids the stream
                raise StreamFailure(f"unreadable stream line: {exc}") from exc
