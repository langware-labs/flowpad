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
import functools
import importlib
import io
import json
import sys
import time
import types
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PYPI_JSON = "https://pypi.org/pypi/flowpad/json"
WHEEL_HOST = "files.pythonhosted.org"
MAX_CANDIDATES = 5


def _load_contract():
    """``flow_sdk.utils.compat`` and ``.semver`` -- THE contract, executed from their files. The parent
    packages are stubs so ``flow_sdk/__init__`` (auth, claude_env, ...) never runs and this script needs no
    installed flowpad; a second copy of the rules here would be the one that drifts silently."""
    if "flow_sdk" not in sys.modules:
        for name, rel in (("flow_sdk", "flow_sdk"), ("flow_sdk.utils", "flow_sdk/utils")):
            stub = types.ModuleType(name)
            stub.__path__ = [str(REPO / rel)]
            sys.modules[name] = stub
    return importlib.import_module("flow_sdk.utils.compat"), importlib.import_module("flow_sdk.utils.semver")


compat, semver = _load_contract()


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)  # noqa: T201
    raise SystemExit(1)


def load_floor(path: Path, key: str) -> str:
    """The floor *key* in *path*: a missing file, broken JSON or an unparseable version fails the gate."""
    if not path.exists():
        fail(f"{path} is missing")
    try:
        floor = compat.declared_floor(compat.load_backend_compat(path), key)
    except compat.CompatError as exc:
        fail(str(exc))
    if floor is None or semver.string2semver(floor) is None:
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


def validate_files() -> tuple[str, str]:
    min_backend = load_floor(REPO / "electron" / "engine-compat.json", "min_backend_version")
    min_desktop = load_floor(REPO / "flow_sdk" / "compat.json", "min_desktop_version")
    version = backend_version()
    if compat.meets_floor(version, min_backend) is not True:
        fail(
            f"this backend ({version}) is below the desktop floor it bundles "
            f"(min_backend_version={min_backend}) — an impossible release"
        )
    print(f"ok: engine-compat.json min_backend_version={min_backend}")  # noqa: T201
    print(f"ok: flow_sdk/compat.json min_desktop_version={min_desktop}")  # noqa: T201
    print(f"ok: backend {version} satisfies the bundled desktop floor")  # noqa: T201
    return min_backend, min_desktop


def trusted_wheel_url(url: object) -> bool:
    """Only PyPI's own file host, over https: the URL comes out of a JSON document, not out of this repo."""
    if not isinstance(url, str):
        return False
    parts = urllib.parse.urlsplit(url)
    return parts.scheme == "https" and parts.hostname == WHEEL_HOST


def wheel_min_desktop(url: str) -> "str | None":
    """`min_desktop_version` read out of a wheel's flow_sdk/compat.json — a zip member
    read, no code from the package ever runs. None = the release predates the contract."""
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 — host checked by trusted_wheel_url
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        try:
            raw = zf.read("flow_sdk/compat.json")
        except KeyError:
            return None
    declared = compat.parse_compat_text(raw.decode("utf-8"), "flow_sdk/compat.json in the wheel")
    return compat.declared_floor(declared, "min_desktop_version")


def resolve(desktop_version: str, min_backend: str) -> None:
    """Walk PyPI newest-first (the same order as electron/engine-compat.js selectCompatibleRelease, over fewer
    candidates -- CI downloads whole wheels) for a release both floors accept."""
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
        if parsed is None or not isinstance(files, list) or compat.meets_floor(version, min_backend) is not True:
            continue
        # A partly-yanked release still has its un-yanked wheel; a yanked wheel is never the one we read.
        wheel = next(
            (f for f in files if str(f.get("filename", "")).endswith(".whl") and not f.get("yanked") and trusted_wheel_url(f.get("url"))),
            None,
        )
        if wheel:
            candidates.append((parsed, version, wheel["url"]))
    candidates.sort(key=functools.cmp_to_key(lambda a, b: semver.compare_semver(a[0], b[0])), reverse=True)
    if not candidates:
        fail(f"no PyPI release satisfies the desktop floor {min_backend}")
    for _, version, url in candidates[:MAX_CANDIDATES]:
        try:
            floor = wheel_min_desktop(url)
        except Exception as exc:  # noqa: BLE001 — a broken candidate is skipped, not fatal
            print(f"skip {version}: could not read its metadata ({exc})", file=sys.stderr)  # noqa: T201
            continue
        verdict = compat.check_pair(
            desktop_version=desktop_version, backend_version=version,
            min_desktop_version=floor, min_backend_version=min_backend,
        )
        if verdict.compatible:
            print(f"ok: desktop {desktop_version} resolves backend {version} (min_desktop_version={floor or 'none (legacy)'})")  # noqa: T201
            return
        print(f"skip {version}: {'; '.join(verdict.reasons)}")  # noqa: T201
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
