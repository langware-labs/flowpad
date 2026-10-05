#!/usr/bin/env python3
"""Fail if a locked dependency's Windows binary needs a Visual C++ DLL that nothing of ours supplies.

``usearch`` imports ``MSVCP140.dll``; a Windows without the Visual C++ Redistributable cannot load it,
so Flowpad ships that one DLL (``flow_sdk/rag/vcruntime/``) and registers it when the import fails.
That fix covers exactly the packages listed below. A new or upgraded dependency that imports another
Redistributable DLL would break search the same way on a clean machine, and CI runners have the
Redistributable installed, so nothing else would ever notice.

This reads the PE import table of every ``.pyd`` / ``.dll`` in each locked package's Windows wheels
(``uv.lock``), with the standard library only, so it runs on any CI image (Linux included). It reports what
the files DECLARE they import. It does not prove that a machine without the runtime loads them: that was
measured once, on a Windows machine, and is recorded in ``flow_sdk/rag/vcruntime/README.md``.

    python scripts/check_windows_wheel_deps.py [--fresh] [--tag cp311 ...] [--cache DIR] [--list]

``uv.lock`` is what a developer installs. A person who runs ``uv tool install flowpad`` resolves FRESH, today,
against PyPI — 117 of the 200 locked packages are different versions (greenlet 3.3.2 imports MSVCP140.dll,
3.5.6 does not). ``--fresh`` scans that resolution instead: it locks a copy of ``pyproject.toml`` with
``uv lock --upgrade`` and scans the result. It is also a moving target, so it belongs in a scheduled job.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

#: The Redistributable DLLs a Windows binary may import, by what supplies them.
#: ``vcruntime140*.dll`` comes with the Python interpreter itself (python.org and uv's builds ship it beside
#: ``python.exe``). Everything else of the Redistributable is not on a clean Windows.
SUPPLIED_BY_PYTHON = frozenset({"vcruntime140.dll", "vcruntime140_1.dll"})
REDIST_DLLS = SUPPLIED_BY_PYTHON | {"msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcomp140.dll", "concrt140.dll"}

#: Packages whose Redistributable imports Flowpad covers itself, and the DLLs it ships for them.
#: Keep in step with ``flow_sdk/rag/runtime.py`` and ``flow_sdk/rag/vcruntime/``.
SHIPPED_BY_FLOWPAD = {"usearch": frozenset({"msvcp140.dll"})}

#: Files nothing of ours loads, with why. ``pywin32`` ships Outlook/Exchange MAPI bindings that import
#: ``MSVCP140.dll``; they load only when something imports ``win32com.mapi``, and nothing in Flowpad does.
#: Matched as a path prefix inside the wheel.
NEVER_LOADED = {"pywin32": ("win32comext/mapi/",)}

PLATFORMS = ("win_amd64", "win_arm64")


def _pe_imports():
    """The stdlib PE import reader ``check_windows_exe_deps.py`` already has (``scripts/`` is not a package)."""
    spec = importlib.util.spec_from_file_location(
        "_check_windows_exe_deps", ROOT / "scripts" / "check_windows_exe_deps.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.imported_dlls


def windows_wheels(lock: Path, tags: tuple[str, ...]) -> dict[str, list[dict]]:
    """``{package: [wheel entries]}`` for the locked Windows wheels of CPython *tags* (or ABI-independent ones)."""
    wheels: dict[str, list[dict]] = {}
    for package in tomllib.loads(lock.read_text())["package"]:
        found = []
        for wheel in package.get("wheels", []):
            filename = wheel["url"].rsplit("/", 1)[-1]
            if not any(f"-{platform}.whl" in filename for platform in PLATFORMS):
                continue
            python_tag = filename.split("-")[-3]
            if python_tag in tags or python_tag.startswith("py3") or "-abi3-" in filename:
                found.append(wheel)
        if found:
            wheels[package["name"]] = found
    return wheels


def fetch(wheel: dict, cache: Path) -> Path:
    """The wheel's file, downloaded once and checked against the lock's own hash."""
    filename = wheel["url"].rsplit("/", 1)[-1]
    path = cache / filename
    expected = wheel["hash"].split(":", 1)[1]
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        with urllib.request.urlopen(wheel["url"], timeout=120) as response:  # noqa: S310 — a pinned https URL from the lock
            path.write_bytes(response.read())
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f"{filename}: does not match the hash in uv.lock")
    return path


def redistributable_imports(wheel: Path, imported_dlls) -> dict[str, set[str]]:
    """``{file inside the wheel: Redistributable DLLs it imports}`` for every ``.pyd`` / ``.dll`` that has any."""
    found: dict[str, set[str]] = {}
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if not name.lower().endswith((".pyd", ".dll")):
                continue
            with tempfile.NamedTemporaryFile(suffix=".bin") as scratch:
                scratch.write(archive.read(name))
                scratch.flush()
                try:
                    needed = {dll.lower() for dll in imported_dlls(Path(scratch.name))} & REDIST_DLLS
                except ValueError:
                    continue  # not a PE file (a data file named .dll)
            if needed:
                found[name] = needed
    return found


def unsupplied(package: str, imports: dict[str, set[str]]) -> set[str]:
    """The Redistributable DLLs this package needs that neither Python nor Flowpad supplies."""
    ignored = NEVER_LOADED.get(package, ())
    needed = (
        set().union(*(dlls for member, dlls in imports.items() if not member.startswith(ignored))) if imports else set()
    )
    return needed - SUPPLIED_BY_PYTHON - SHIPPED_BY_FLOWPAD.get(package, frozenset())


def fresh_lock(workdir: Path) -> Path:
    """A lock of ``pyproject.toml`` resolved against PyPI now, as ``uv tool install flowpad`` would — written
    in a scratch copy, so the repository's own ``uv.lock`` is never touched. The package is not built, but its
    dynamic version is read from ``flow_sdk/_version.py``, so that one file is copied."""
    (workdir / "flow_sdk").mkdir(parents=True, exist_ok=True)
    (workdir / "flow_sdk" / "__init__.py").touch()
    shutil.copy(ROOT / "flow_sdk" / "_version.py", workdir / "flow_sdk" / "_version.py")
    shutil.copy(ROOT / "pyproject.toml", workdir / "pyproject.toml")
    if (ROOT / "README.md").exists():
        shutil.copy(ROOT / "README.md", workdir / "README.md")
    subprocess.run(["uv", "lock", "--upgrade"], cwd=workdir, check=True, capture_output=True)  # noqa: S607
    return workdir / "uv.lock"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", action="append", help="CPython tag of the wheels to scan (default: cp311)")
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "flowpad-wheel-scan")
    parser.add_argument("--lock", type=Path, default=ROOT / "uv.lock")
    parser.add_argument("--fresh", action="store_true", help="scan what a new install resolves today, not uv.lock")
    parser.add_argument(
        "--list", action="store_true", help="print every package's Redistributable imports, not only the failures"
    )
    args = parser.parse_args(argv)
    tags = tuple(args.tag or ["cp311"])
    args.cache.mkdir(parents=True, exist_ok=True)
    imported_dlls = _pe_imports()
    if args.fresh:
        args.lock = fresh_lock(Path(tempfile.mkdtemp(prefix="flowpad-fresh-lock-")))

    failures = 0
    scanned = 0
    for package, wheels in sorted(windows_wheels(args.lock, tags).items()):
        merged: dict[str, set[str]] = {}
        for wheel in wheels:
            for member, needed in redistributable_imports(fetch(wheel, args.cache), imported_dlls).items():
                merged.setdefault(member, set()).update(needed)
            scanned += 1
        missing = unsupplied(package, merged)
        if missing:
            failures += 1
            print(f"FAIL {package}: needs {', '.join(sorted(missing))} — not supplied by Python or by Flowpad")  # noqa: T201
            for member, needed in sorted(merged.items()):
                print(f"       {member}: {', '.join(sorted(needed))}")  # noqa: T201
        elif args.list or merged:
            covered = sorted(set().union(*merged.values())) if merged else []
            print(f"ok   {package}: {', '.join(covered) if covered else 'no Redistributable DLLs'}")  # noqa: T201
    print(f"{scanned} wheel(s) scanned for {', '.join(tags)}: {failures} package(s) need an unsupplied DLL")  # noqa: T201
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
