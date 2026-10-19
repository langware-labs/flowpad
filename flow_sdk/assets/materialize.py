"""Filesystem materialization shared by installation and worker attachment."""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from flow_sdk._compat import StrEnum


class MaterializationMode(StrEnum):
    COPY = "copy"
    LINK = "link"


def extended_length_path(p: Path) -> Path:
    """Return ``p`` as a Windows extended-length (``\\\\?\\``) path so writes
    under it bypass the 260-char MAX_PATH limit. No-op off Windows and when the
    prefix is already present. The prefix requires a fully-qualified,
    backslash-separated path with no ``.``/``..`` components, so resolve first."""
    if os.name != "nt":
        return p
    resolved = os.path.abspath(str(p))
    if resolved.startswith("\\\\?\\"):
        return Path(resolved)
    if resolved.startswith("\\\\"):  # UNC: \\server\share -> \\?\UNC\server\share
        return Path("\\\\?\\UNC" + resolved[1:])
    return Path("\\\\?\\" + resolved)


def remove_path(path: Path) -> None:
    """Remove an entry, including a dangling symlink, without following it."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def prune_empty_dirs(start: Path, stop: Path | None) -> None:
    """Remove ``start`` and its parents while they are empty, never ``stop`` or anything above it.

    A file removed from a tree must not leave its folder behind (an empty example folder reads as a
    broken dataset row; an emptied asset folder is a husk)."""
    if stop is None:
        return
    stop = Path(stop).resolve()
    here = Path(start).resolve()
    while here != stop and here.is_relative_to(stop):
        try:
            here.rmdir()  # only an EMPTY directory goes
        except OSError:
            return
        here = here.parent


def materialize_asset_sync(source: Path, destination: Path, *, mode: MaterializationMode = MaterializationMode.COPY, overwrite: bool = False, exclude: tuple[str, ...] = (), prepare: Callable[[Path], None] | None = None) -> Path:
    """Materialize an exact destination, refusing overlapping source trees."""
    source = Path(source).expanduser().resolve(strict=True)
    destination = Path(destination).expanduser().absolute()
    destination = destination.parent.resolve() / destination.name
    mode = MaterializationMode(mode)
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Source and destination asset trees overlap")
    if (destination.exists() or destination.is_symlink()) and not overwrite:
        raise FileExistsError(destination)

    destination.parent.mkdir(parents=True, exist_ok=True)
    # Finish the potentially failing copy before replacing existing bytes.
    # Staging sits ~30 chars deeper than the destination (``.asset-install-*/new``,
    # ``.../previous``), which pushes a deep received tree past Windows' MAX_PATH
    # while it is copied in, swapped, and cleaned up — so the whole staging area
    # lives under an extended-length path.
    with tempfile.TemporaryDirectory(prefix=".asset-install-", dir=extended_length_path(destination.parent)) as temporary:
        staged = Path(temporary) / "new" / destination.name
        staged.parent.mkdir()
        if mode is MaterializationMode.LINK:
            staged.symlink_to(source, target_is_directory=source.is_dir())
        elif source.is_dir():
            shutil.copytree(extended_length_path(source), staged, ignore=shutil.ignore_patterns(*exclude) if exclude else None)
        else:
            shutil.copy2(extended_length_path(source), staged)
        if prepare is not None:
            prepare(staged)
        if (destination.exists() or destination.is_symlink()) and not overwrite:
            raise FileExistsError(destination)
        backup = Path(temporary) / "previous"
        existed = destination.exists() or destination.is_symlink()
        if existed:
            destination.replace(backup)
        try:
            staged.replace(destination)
        except OSError:
            if existed:
                backup.replace(destination)
            raise

    return destination


async def materialize_asset(source: Path, destination: Path, *, mode: MaterializationMode = MaterializationMode.COPY, overwrite: bool = False, exclude: tuple[str, ...] = ()) -> Path:
    return await asyncio.to_thread(materialize_asset_sync, source, destination, mode=mode, overwrite=overwrite, exclude=exclude)
