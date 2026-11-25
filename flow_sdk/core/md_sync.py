"""Run ``syncmd`` on a project folder and answer with a :class:`MdSyncStatusSpec`.

``syncmd`` is an optional command-line tool. Everything that can go wrong with it — not
installed, too old, not a git repository, a failed run — is a ``state`` of the answer, never an
exception: a missing tool is a warning in the footer, not a broken screen.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

from flow_sdk.schema.data_spec.md_sync_spec import (
    MdSyncStaleSpec,
    MdSyncState,
    MdSyncStatusSpec,
    MdSyncUnsyncedSpec,
)
from flow_sdk.utils.git import find_project_root
from flow_sdk.utils.semver import Semver, compare_semver, string2semver

logger = logging.getLogger(__name__)

EXECUTABLE = "syncmd"
#: The first version with sources and the ``unconfigured`` report.
MIN_VERSION = Semver(0, 2, 0, "")
INSTALL_HINT = "npm install -g syncmd"

_STALE = {"propagated", "diverged_resolved", "conflict"}
_WRITES = {"write", "create", "delete"}

#: The installed executable's version, kept until the file changes: ``(path, mtime) → output``.
_version: tuple[tuple[str, float], str] | None = None


async def _run(exe: str, *args: str) -> tuple[int, str, str]:
    """Run ``exe`` with an argument list (no shell). ``-1`` when it could not be started."""
    try:
        proc = await asyncio.create_subprocess_exec(
            exe, *args, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except OSError as e:
        return -1, "", str(e)
    out, err = await proc.communicate()
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def _error(code: int, out: str, err: str) -> MdSyncStatusSpec:
    return MdSyncStatusSpec(state=MdSyncState.ERROR, detail=(err or out).strip() or f"syncmd exited with {code}")


async def _version_of(exe: str) -> str:
    """What ``exe --version`` prints ("" when it fails), asked once per installed file."""
    global _version
    key = (exe, os.stat(exe).st_mtime)
    if _version and _version[0] == key:
        return _version[1]
    code, out, _ = await _run(exe, "--version")
    if code != 0:
        return ""
    _version = (key, out)
    return out


async def _tool(root: str | None) -> tuple[str, MdSyncStatusSpec | None]:
    """The executable to run, or the status that says why there is nothing to run."""
    if not root or not Path(root).is_dir() or not find_project_root(root):
        return "", MdSyncStatusSpec(state=MdSyncState.NOT_A_REPO)
    # ``which`` applies the platform's rules: ``syncmd.exe`` and npm's ``syncmd.cmd`` on Windows.
    exe = shutil.which(EXECUTABLE)
    if not exe:
        return "", MdSyncStatusSpec(state=MdSyncState.UNAVAILABLE, install_hint=INSTALL_HINT)
    found = string2semver(await _version_of(exe))
    if not found:
        return "", MdSyncStatusSpec(state=MdSyncState.ERROR, detail="syncmd --version gave no version")
    if compare_semver(found, MIN_VERSION) < 0:
        version = f"{found.major}.{found.minor}.{found.patch}"
        return "", MdSyncStatusSpec(state=MdSyncState.OUTDATED, version=version, install_hint=INSTALL_HINT)
    return exe, None


async def _report(exe: str, *args: str) -> dict | MdSyncStatusSpec:
    """A syncmd JSON report, or the error status when it gave none."""
    code, out, err = await _run(exe, *args, "--json")
    try:
        report = json.loads(out)
    except ValueError:
        report = None
    if not isinstance(report, dict):
        logger.warning("syncmd %s failed (exit %s): %s", args[0], code, err.strip())
        return _error(code, out, err)
    return report


def _status(report: dict) -> MdSyncStatusSpec:
    stale = []
    for group in report.get("groups") or []:
        if group.get("status") not in _STALE:
            continue
        targets = [m.get("path", "") for m in group.get("mounts") or [] if m.get("action") in _WRITES]
        stale.append(
            MdSyncStaleSpec(
                name=str(group.get("name") or ""),
                kind=str(group.get("type") or ""),
                source=str(group.get("winner_path") or ""),
                targets=targets,
            )
        )
    unsynced = [
        MdSyncUnsyncedSpec(source=str(u.get("source") or ""), paths=list(u.get("paths") or []))
        for u in report.get("unconfigured") or []
    ]
    return MdSyncStatusSpec(state=MdSyncState.OK, stale=stale, unsynced=unsynced)


async def _plan(exe: str, root: str) -> MdSyncStatusSpec:
    report = await _report(exe, "plan", root)
    return _status(report) if isinstance(report, dict) else report


async def status(root: str | None) -> MdSyncStatusSpec:
    """What a sync of the project at ``root`` would do. Writes nothing."""
    exe, refused = await _tool(root)
    return refused or await _plan(exe, str(root))


async def sync(root: str | None) -> MdSyncStatusSpec:
    """Bring the stale files together, then answer with the status as it is now."""
    exe, refused = await _tool(root)
    if refused:
        return refused
    # No ``.syncmd.bak`` files: the project is a git repository, which is the backup.
    report = await _report(exe, "sync", str(root), "--backup=false")
    if not isinstance(report, dict):
        return report
    after = await _plan(exe, str(root))
    return after.model_copy(update={"written": int((report.get("summary") or {}).get("written") or 0)})


async def add_source(root: str | None, name: str) -> MdSyncStatusSpec:
    """Start syncing source ``name`` (saved in the project's ``syncmd.toml``), then the status."""
    exe, refused = await _tool(root)
    if refused:
        return refused
    code, out, err = await _run(exe, "source", "add", name, "--path", str(root))
    return await _plan(exe, str(root)) if code == 0 else _error(code, out, err)
