"""Bidirectional desktop <-> backend version compatibility.

Two floors, one per side, each owned by the side that declares it:

* ``flow_sdk/compat.json`` — ``{"min_desktop_version": "X.Y.Z"}``: the oldest
  desktop app THIS backend release supports. Shipped in the wheel (plain data,
  listed in ``[tool.setuptools.package-data]``), so any installed or staged
  copy can be read without running package code. Mirrored on the desktop side
  by ``electron/engine-compat.json`` (``min_backend_version``), read through
  ``electron/engine-compat.js``.
* ``FLOWPAD_DESKTOP_MIN_BACKEND_VERSION`` — the desktop's own floor, passed as
  an env var by the Electron shell when it spawns ``flow start`` (next to
  ``FLOWPAD_DESKTOP_VERSION``). A backend that was not spawned by the desktop
  sees neither and is never constrained — CLI/headless installs stay free.

Deliberately NOT a ``DataSpec`` schema (an exception approved by the repository owner, 2026-10-19):
the declaration must stay readable as plain JSON without importing ``flow_sdk`` -- by the desktop
before any Python runs and by ``scripts/check_version_compat.py`` in CI. This module validates it.

A pair is compatible only when BOTH hold (a newer version is never assumed
compatible):

    backend_version >= desktop.min_backend_version
    desktop_version >= backend.min_desktop_version

Comparisons use the shared semver ordering (``flow_sdk/utils/semver.py``,
mirrored 1:1 by ``electron/semver.js``) so both sides always agree. A missing
file or missing key is the documented legacy policy: no constraint (releases
that predate this contract never declared one). An UNPARSEABLE version string
on either side of a declared floor is rejected, not waved through.

The files are plain JSON objects and unknown keys are ignored, so the format
can later grow explicit ranges, maximums, or per-version exceptions without
breaking older readers.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NamedTuple, Optional

from flow_sdk.utils.semver import compare_semver, string2semver

#: The backend's own compatibility declaration, shipped beside this package.
COMPAT_FILE = Path(__file__).resolve().parent.parent / "compat.json"

#: Set by electron/uv-manager.js on the backend it spawns (and inherited by the
#: monitor + server), next to FLOWPAD_DESKTOP=1. Absent for headless installs.
ENV_DESKTOP_VERSION = "FLOWPAD_DESKTOP_VERSION"
ENV_DESKTOP_MIN_BACKEND = "FLOWPAD_DESKTOP_MIN_BACKEND_VERSION"


class CompatError(ValueError):
    """A compat file exists but is not a JSON object — invalid metadata, never silently ignored."""


class CompatVerdict(NamedTuple):
    compatible: bool
    #: Human-readable reasons when incompatible (empty when compatible).
    reasons: list


def parse_compat_text(text: str, source: str = "compat.json") -> dict:
    """A compat declaration's text as a dict. Raises :class:`CompatError` unless it is a JSON object --
    a broken declaration must be seen, never read as "no constraint"."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise CompatError(f"{source} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise CompatError(f"{source} must be a JSON object, got {type(data).__name__}")
    return data


def declared_floor(data: dict, key: str) -> Optional[str]:
    """The non-empty string floor under *key*, or ``None`` (absent / not a string = no constraint)."""
    value = data.get(key)
    return value if isinstance(value, str) and value else None


def load_backend_compat(path: Path = COMPAT_FILE) -> dict:
    """The declaration at *path* as a dict; ``{}`` when the file is absent (legacy)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    return parse_compat_text(text, str(path))


def backend_min_desktop_version(path: Path = COMPAT_FILE) -> Optional[str]:
    """This backend's declared desktop floor, or ``None`` (no file / no key = no constraint)."""
    return declared_floor(load_backend_compat(path), "min_desktop_version")


def meets_floor(version: Optional[str], floor: Optional[str]) -> Optional[bool]:
    """``version >= floor`` under the shared semver ordering.

    ``None`` floor → ``True`` (no constraint). An unparseable *version* or
    *floor* against a declared constraint → ``None`` (indeterminate — the
    caller decides, and every caller here rejects it).
    """
    if floor is None:
        return True
    v = string2semver(version)
    f = string2semver(floor)
    if v is None or f is None:
        return None
    return compare_semver(v, f) >= 0


def check_pair(
    *,
    desktop_version: Optional[str],
    backend_version: str,
    min_desktop_version: Optional[str],
    min_backend_version: Optional[str],
) -> CompatVerdict:
    """Both directions of the contract for one concrete (desktop, backend) pair.

    Each floor is optional (``None`` = no constraint, the legacy policy); a
    declared floor against a missing or unparseable version is a failure.
    """
    reasons: list = []
    if min_desktop_version is not None:
        ok = meets_floor(desktop_version, min_desktop_version)
        if ok is None:
            reasons.append(
                f"cannot compare desktop version {desktop_version!r} with the backend's "
                f"minimum desktop version {min_desktop_version!r}"
            )
        elif not ok:
            reasons.append(
                f"FlowPad Backend {backend_version} requires Desktop {min_desktop_version} "
                f"or newer (installed Desktop: {desktop_version})"
            )
    if min_backend_version is not None:
        ok = meets_floor(backend_version, min_backend_version)
        if ok is None:
            reasons.append(
                f"cannot compare backend version {backend_version!r} with the desktop's "
                f"minimum backend version {min_backend_version!r}"
            )
        elif not ok:
            reasons.append(
                f"FlowPad Desktop{f' {desktop_version}' if desktop_version else ''} requires "
                f"Backend {min_backend_version} or newer (backend: {backend_version})"
            )
    return CompatVerdict(compatible=not reasons, reasons=reasons)


def desktop_constraints(env: Optional[dict] = None) -> tuple[Optional[str], Optional[str]]:
    """``(desktop_version, desktop_min_backend)`` the Electron shell handed this
    process, both ``None`` for a backend the desktop does not manage."""
    e = os.environ if env is None else env
    version = e.get(ENV_DESKTOP_VERSION) or None
    floor = e.get(ENV_DESKTOP_MIN_BACKEND) or None
    return version, floor
