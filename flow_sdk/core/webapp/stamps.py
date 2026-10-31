"""What an app was installed and built from, as a short stamp — so a changed lockfile reinstalls and changed
sources rebuild, and "a folder exists" is never taken for "done".

Cheap by design: the install stamp hashes the dependency manifests and lockfiles only; the build stamp the
newest modification time among the app's sources, from a walk that skips what is generated and stops at
``WALK_LIMIT`` files (past it the stamp is ``""``: unknown, and nothing is rebuilt on its account).
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

#: The files an install is made from.
MANIFESTS = ("package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
             "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "requirements-dev.txt", "Pipfile.lock",
             "pubspec.yaml", "pubspec.lock")
#: Generated folders a source walk never enters.
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".dart_tool",
             ".turbo", ".cache", "setup", ".installed", "coverage", "out"}
WALK_LIMIT = 20000


def install(app: Any) -> str:
    """The stamp of the app's dependency manifests (and its declared ``install_check`` folder's presence)."""
    folder = Path(getattr(app, "asset_ref", "") or "")
    if not folder.is_dir():
        return ""
    digest = hashlib.sha1()
    for name in MANIFESTS:
        for path in (folder / name, *(folder / sub / name for sub in ("frontend", "backend", "app"))):
            if path.is_file():
                digest.update(str(path.relative_to(folder)).encode())
                digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def build(app: Any) -> str:
    """The stamp of the app's sources: the newest modification time under its folder, generated folders and
    its own build output skipped. ``""`` when the folder is too big to walk cheaply."""
    folder = Path(getattr(app, "asset_ref", "") or "")
    if not folder.is_dir():
        return ""
    served = str(getattr(app, "build", "") or "")
    skip = SKIP_DIRS | ({served.strip("/").split("/")[0]} if served not in ("", ".") else set())
    newest, seen = 0.0, 0
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
        for name in files:
            seen += 1
            if seen > WALK_LIMIT:
                return ""
            try:
                newest = max(newest, os.stat(os.path.join(root, name)).st_mtime)
            except OSError:
                continue
    return f"{int(newest)}-{seen}"


__all__ = ["build", "install"]
