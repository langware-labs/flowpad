"""Filesystem materialization shared by installation and worker attachment."""
from __future__ import annotations

import asyncio
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from flow_sdk._compat import StrEnum


class MaterializationMode(StrEnum):
    COPY = "copy"
    LINK = "link"


def remove_path(path: Path) -> None:
    """Remove an entry, including a dangling symlink, without following it."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


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
    with tempfile.TemporaryDirectory(prefix=".asset-install-", dir=destination.parent) as temporary:
        staged = Path(temporary) / "new" / destination.name
        staged.parent.mkdir()
        if mode is MaterializationMode.LINK:
            staged.symlink_to(source, target_is_directory=source.is_dir())
        elif source.is_dir():
            shutil.copytree(source, staged, ignore=shutil.ignore_patterns(*exclude) if exclude else None)
        else:
            shutil.copy2(source, staged)
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
