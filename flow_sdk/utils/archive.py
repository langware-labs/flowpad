"""Safe zip extraction — the one extractor for archives a sender controls.

A received zip is untrusted: a member may name ``../../x`` (zip-slip), be a
symlink pointing anywhere, or decompress to far more than it weighs (a zip
bomb). ``safe_extract_zip`` refuses the first and the last and skips symlinks,
so callers never extract with a bare ``extractall``.

Synchronous — callers run it via ``asyncio.to_thread``.
"""

from __future__ import annotations

import hashlib
import shutil
import stat
import zipfile
from pathlib import Path, PurePosixPath

from flow_sdk.assets.materialize import extended_length_path
from flow_sdk.fs_store.origin.fs_origin import safe_join

#: Ceiling on the total uncompressed bytes one archive may expand to.
MAX_UNCOMPRESSED_BYTES = 4 * 1024**3
#: Ceiling on the number of members one archive may hold.
MAX_MEMBERS = 100_000
#: macOS's resource-fork folder inside zips it makes — never content.
MACOSX_DIR = "__MACOSX"
_CHUNK = 1024 * 1024
_PREVIEW_DONE = ".flowpad-extracted"


class UnsafeArchiveError(ValueError):
    """Not a usable zip: a path outside its destination, over a cap, or not a zip."""


def is_zip_filename(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() == ".zip"


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def safe_extract_zip(
    zip_path: Path,
    dest: Path,
    *,
    max_bytes: int = MAX_UNCOMPRESSED_BYTES,
    max_members: int = MAX_MEMBERS,
) -> None:
    """Extract ``zip_path`` into ``dest``.

    Validates the WHOLE archive before writing anything, so a refused archive
    leaves ``dest`` untouched. Directory entries are created; symlink members
    and ``__MACOSX`` are skipped. Raises ``UnsafeArchiveError``.
    """
    try:
        zf = zipfile.ZipFile(zip_path, "r")
    except zipfile.BadZipFile as e:
        raise UnsafeArchiveError(f"not a zip archive: {e}") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > max_members:
            raise UnsafeArchiveError(f"archive has {len(infos)} members (cap {max_members})")
        if sum(i.file_size for i in infos) > max_bytes:
            raise UnsafeArchiveError(f"archive expands past {max_bytes} bytes")
        plan: list[tuple[zipfile.ZipInfo, Path]] = []
        for info in infos:
            name = info.filename.replace("\\", "/").rstrip("/")
            if not name or _is_symlink(info) or name.split("/")[0] == MACOSX_DIR:
                continue
            # The canonical root-relative guard: absolute, drive, ``..`` and
            # resolve-escapes are all refused.
            target = safe_join(dest, name)
            if target is None:
                raise UnsafeArchiveError(f"member escapes the destination: {info.filename!r}")
            plan.append((info, target))

        # The header sizes are the sender's claim; count the real bytes too.
        budget = max_bytes
        made: set[Path] = set()
        for info, target in plan:
            folder = target if info.is_dir() else target.parent
            if folder not in made:
                extended_length_path(folder).mkdir(parents=True, exist_ok=True)
                made.add(folder)
            if info.is_dir():
                continue
            with zf.open(info) as src, open(extended_length_path(target), "wb") as out:
                while chunk := src.read(_CHUNK):
                    budget -= len(chunk)
                    if budget < 0:
                        raise UnsafeArchiveError(f"archive expands past {max_bytes} bytes")
                    out.write(chunk)


def unwrap_single_folder(root: Path) -> Path:
    """A zip of one folder (``logs.zip`` → ``logs/…``) IS that folder: return it,
    else ``root``."""
    children = [c for c in root.iterdir() if c.name != MACOSX_DIR]
    return children[0] if len(children) == 1 and children[0].is_dir() else root


# ---------------------------------------------------------------------------
# Preview: a zip opened to look inside, extracted to the temp dir
# ---------------------------------------------------------------------------


def preview_root() -> Path:
    """This instance's archive-preview area under Flowpad's temp dir. Disposable:
    the OS may wipe it (macOS does at boot) and a preview simply re-extracts."""
    import tempfile  # noqa: PLC0415

    from flow_sdk import config  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    base = Path(config.FLOWPAD_TEMP_DIR or Path(tempfile.gettempdir()) / "flowpad_temp")
    return base / get_instance_settings().instance_name / "archive-preview"


def extract_preview(zip_path: Path) -> Path:
    """Extract ``zip_path`` for viewing and return the folder holding its contents.

    Keyed by the zip's path, size and mtime, so a repeat preview reuses the
    folder and a changed zip extracts afresh. A finished-marker is written last:
    a half-done extraction (a crash, a refused archive) is redone, never shown.
    A zip of one folder returns that folder (``unwrap_single_folder``).
    Raises ``UnsafeArchiveError`` for anything that is not a usable zip file."""
    if not is_zip_filename(zip_path.name) or not zip_path.is_file():
        raise UnsafeArchiveError(f"not a zip file: {zip_path.name}")
    st = zip_path.stat()
    key = hashlib.sha256(f"{zip_path}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:16]
    slot = preview_root() / key
    out = slot / PurePosixPath(zip_path.name).stem
    if not (slot / _PREVIEW_DONE).is_file():
        shutil.rmtree(slot, ignore_errors=True)
        safe_extract_zip(zip_path, out)
        (slot / _PREVIEW_DONE).write_text(str(zip_path))
    return unwrap_single_folder(out)
