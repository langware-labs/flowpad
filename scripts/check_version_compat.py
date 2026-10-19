#!/usr/bin/env python3
"""Release gate for the desktop <-> backend version-compatibility contract.

Validates the two compatibility declarations and, optionally, that a given
desktop version can resolve at least one compatible backend release on PyPI —
WITHOUT executing any package code (candidate floors are read straight out of
the wheel zip).

Default (no network):
    python3 scripts/check_version_compat.py
  * electron/engine-compat.json parses and declares a semver-parseable
    `min_backend_version`
  * flow_sdk/compat.json parses and declares a semver-parseable
    `min_desktop_version`
  * flow_sdk/_version.py holds a parseable version that satisfies the
    desktop's floor (a release can never ship below the floor it bundles)

Release resolution (network; for CI of a desktop release):
    python3 scripts/check_version_compat.py --resolve --desktop-version 0.2.56
  Walks PyPI releases newest-first, keeps those >= min_backend_version, reads
  each candidate wheel's flow_sdk/compat.json, and exits 0 on the first one
  whose min_desktop_version the given desktop satisfies.

Exit codes: 0 ok, 1 validation/resolution failed, 2 usage error.
Stdlib only — runnable from the private desktop-build repo's workflow against a
checkout of this repo (it needs no installed flowpad and no third-party deps).
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PYPI_JSON = "https://pypi.org/pypi/flowpad/json"
MAX_CANDIDATES = 5

# The shared semver module, loaded from its file so this script needs no installed
# flow_sdk (and never triggers flow_sdk/__init__'s imports).
_spec = importlib.util.spec_from_file_location("_compat_semver", REPO / "flow_sdk" / "utils" / "semver.py")
semver = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(semver)


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)  # noqa: T201
    raise SystemExit(1)


def load_floor(path: Path, key: str) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{path} is missing")
    except ValueError as exc:
        fail(f"{path} is not valid JSON: {exc}")
    if not isinstance(data, dict):
        fail(f"{path} must be a JSON object")
    floor = data.get(key)
    if not isinstance(floor, str) or semver.string2semver(floor) is None:
        fail(f"{path} must declare a semver-parseable {key} (got {floor!r})")
    return floor


def backend_version() -> str:
    text = (REPO / "flow_sdk" / "_version.py").read_text(encoding="utf-8")
    for line in text.splitlines():
        if "__version__" in line and "=" in line:
            version = line.split("=", 1)[1].strip().strip("\"'")
            if semver.string2semver(version) is None:
                fail(f"flow_sdk/_version.py holds an unparseable version: {version!r}")
            return version
    fail("flow_sdk/_version.py has no __version__")
    raise AssertionError  # unreachable


def meets(version: str, floor: str) -> bool:
    v, f = semver.string2semver(version), semver.string2semver(floor)
    return v is not None and f is not None and semver.compare_semver(v, f) >= 0


def validate_files() -> tuple[str, str]:
    min_backend = load_floor(REPO / "electron" / "engine-compat.json", "min_backend_version")
    min_desktop = load_floor(REPO / "flow_sdk" / "compat.json", "min_desktop_version")
    version = backend_version()
    if not meets(version, min_backend):
        fail(
            f"this backend ({version}) is below the desktop floor it bundles "
            f"(min_backend_version={min_backend}) — an impossible release"
        )
    print(f"ok: engine-compat.json min_backend_version={min_backend}")  # noqa: T201
    print(f"ok: flow_sdk/compat.json min_desktop_version={min_desktop}")  # noqa: T201
    print(f"ok: backend {version} satisfies the bundled desktop floor")  # noqa: T201
    return min_backend, min_desktop


def wheel_min_desktop(url: str) -> "str | None":
    """`min_desktop_version` read out of a wheel's flow_sdk/compat.json — a zip member
    read, no code from the package ever runs. None = the release predates the contract."""
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 — files.pythonhosted.org, from PyPI's own index
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        try:
            raw = zf.read("flow_sdk/compat.json")
        except KeyError:
            return None
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("flow_sdk/compat.json in the wheel is not a JSON object")
    floor = parsed.get("min_desktop_version")
    return floor if isinstance(floor, str) and floor else None


def resolve(desktop_version: str, min_backend: str) -> None:
    if semver.string2semver(desktop_version) is None:
        print(f"usage: --desktop-version {desktop_version!r} is not a parseable version", file=sys.stderr)  # noqa: T201
        raise SystemExit(2)
    # PyPI's CDN edges disagree for minutes after an upload; a unique query string
    # skips the edge cache (the same trick as flow_sdk/server/routes/version.py),
    # so a release published moments ago is already visible to this gate.
    with urllib.request.urlopen(f"{PYPI_JSON}?t={time.time_ns()}", timeout=60) as resp:  # noqa: S310
        doc = json.load(resp)
    candidates = []
    for version, files in (doc.get("releases") or {}).items():
        parsed = semver.string2semver(version)
        if parsed is None or not isinstance(files, list) or not files:
            continue
        if all(f.get("yanked") for f in files):
            continue
        wheel = next((f for f in files if str(f.get("filename", "")).endswith(".whl")), None)
        if wheel and meets(version, min_backend):
            candidates.append((parsed, version, wheel["url"]))
    candidates.sort(key=lambda c: semver._cmp_key(c[0]), reverse=True)
    if not candidates:
        fail(f"no PyPI release satisfies the desktop floor {min_backend}")
    for _, version, url in candidates[:MAX_CANDIDATES]:
        try:
            floor = wheel_min_desktop(url)
        except Exception as exc:  # noqa: BLE001 — a broken candidate is skipped, not fatal
            print(f"skip {version}: could not read its metadata ({exc})", file=sys.stderr)  # noqa: T201
            continue
        if floor is None or meets(desktop_version, floor):
            print(f"ok: desktop {desktop_version} resolves backend {version} (min_desktop_version={floor or 'none (legacy)'})")  # noqa: T201
            return
        print(f"skip {version}: it requires desktop {floor} or newer")  # noqa: T201
    fail(
        f"none of the newest {MAX_CANDIDATES} eligible PyPI releases is compatible with "
        f"desktop {desktop_version} — do not publish this desktop release"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--resolve", action="store_true", help="also resolve a compatible PyPI release (network)")
    parser.add_argument("--desktop-version", help="desktop version to resolve for (required with --resolve)")
    args = parser.parse_args()
    min_backend, _ = validate_files()
    if args.resolve:
        if not args.desktop_version:
            parser.error("--resolve requires --desktop-version")
        resolve(args.desktop_version, min_backend)


if __name__ == "__main__":
    main()
