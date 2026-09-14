"""Confined, symlink-free file I/O beneath one root. Blocking; the source runs it in a thread.

Keys use ``/`` separators and are relative; absolute keys, empty parts, ``.``/``..`` and the
reserved temporary name are refused before any I/O. A symlinked directory anywhere on the
way is refused; a symlink leaf is not a file. A write lands in a temporary sibling and is
renamed into place only after the stream completed and the handle closed.
"""

from __future__ import annotations

import os
import stat
import tempfile
from typing import BinaryIO, Callable, Optional

from flow_sdk.sources.errors import Unsupported

TMP_PREFIX = ".flow-source-"
TMP_SUFFIX = ".tmp"


def relative_key(path: str) -> str:
    if not isinstance(path, str):
        raise TypeError(f"path must be a string, got {type(path).__name__}")
    if not path or path.startswith("/") or "\\" in path:
        raise ValueError(f"path must be a relative path with '/' separators: {path!r}")
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"path has an empty, '.' or '..' part: {path!r}")
    leaf = parts[-1]
    if leaf.startswith(TMP_PREFIX) and leaf.endswith(TMP_SUFFIX):
        raise ValueError(f"path uses the reserved temporary name pattern: {path!r}")
    return path


def real_directory(root: str) -> Optional[str]:
    """``root`` resolved, if it is a directory; ``None`` when absent."""
    try:
        st = os.stat(root)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(st.st_mode):
        raise NotADirectoryError(root)
    return os.path.realpath(root)


class Upload:
    """An in-progress write: bytes go to a temporary sibling until ``commit`` renames it."""

    def __init__(self, handle: BinaryIO, tmp_path: str, final_path: str) -> None:
        self.handle = handle
        self.tmp_path = tmp_path
        self.final_path = final_path

    def commit(self) -> os.stat_result:
        self.handle.close()
        os.replace(self.tmp_path, self.final_path)
        return os.stat(self.final_path)

    def discard(self) -> None:
        try:
            self.handle.close()
        finally:
            try:
                os.unlink(self.tmp_path)
            except FileNotFoundError:
                pass


class Folder:
    def __init__(self, root: str) -> None:
        self.root = root

    # ── resolution ──────────────────────────────────────────────────────────
    def _path(self, key: str) -> str:
        """The absolute path of ``key``, refusing a symlinked directory on the way. The leaf
        may or may not exist."""
        current = self.root
        parts = key.split("/")
        for part in parts[:-1]:
            current = os.path.join(current, part)
            try:
                st = os.lstat(current)
            except FileNotFoundError:
                return os.path.join(current, *parts[parts.index(part) + 1 :])
            if stat.S_ISLNK(st.st_mode):
                raise ValueError(f"a symlinked directory is on the path: {key!r}")
            if not stat.S_ISDIR(st.st_mode):
                raise ValueError(f"a parent of {key!r} is not a directory")
        return os.path.join(current, parts[-1])

    # ── reads ───────────────────────────────────────────────────────────────
    def stat(self, key: str) -> Optional[os.stat_result]:
        """The status of the regular file at ``key``; ``None`` when confirmed absent."""
        path = self._path(key)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(st.st_mode):
            return None  # a symlink leaf is not a file
        if stat.S_ISDIR(st.st_mode):
            raise IsADirectoryError(path)
        if not stat.S_ISREG(st.st_mode):
            raise Unsupported(f"not a regular file: {key!r}")
        return st

    def scan(self, prefix: str, skip: Optional[Callable[[str], bool]] = None) -> list[tuple[str, os.stat_result]]:
        """Every regular file beneath the root whose key starts with ``prefix``, sorted by key.
        Symlinks are never followed; in-progress writes and vanished entries are skipped, and so
        is any directory or file whose bare name ``skip`` refuses — pruned, never descended."""
        found: list[tuple[str, os.stat_result]] = []
        for dirpath, dirnames, filenames in os.walk(self.root, followlinks=False):
            dirnames[:] = sorted(
                d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)) and not (skip and skip(d))
            )
            rel_dir = os.path.relpath(dirpath, self.root)
            for name in filenames:
                if (name.startswith(TMP_PREFIX) and name.endswith(TMP_SUFFIX)) or (skip and skip(name)):
                    continue
                key = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
                if not key.startswith(prefix):
                    continue
                try:
                    st = os.lstat(os.path.join(dirpath, name))
                except FileNotFoundError:
                    continue
                if stat.S_ISREG(st.st_mode):
                    found.append((key, st))
        found.sort()
        return found

    def open_read(self, key: str, chunk_size: int) -> tuple[Optional[BinaryIO], bytes]:
        """Open ``key`` for reading and read its first chunk. An empty file yields no handle."""
        path = self._path(key)
        st = os.lstat(path)  # FileNotFoundError → NotFound at the boundary
        if stat.S_ISLNK(st.st_mode):
            raise FileNotFoundError(path)
        if stat.S_ISDIR(st.st_mode):
            raise IsADirectoryError(path)
        if not stat.S_ISREG(st.st_mode):
            raise Unsupported(f"not a regular file: {key!r}")
        handle: BinaryIO = open(path, "rb")  # noqa: SIM115 — closed by the stream's owner
        first = handle.read(chunk_size)
        if not first:
            handle.close()
            return None, b""
        return handle, first

    # ── writes ──────────────────────────────────────────────────────────────
    def begin_write(self, key: str, head: list[bytes]) -> Upload:
        final = self._path(key)
        parent = os.path.dirname(final)
        os.makedirs(parent, exist_ok=True)
        if os.path.isdir(final):
            raise IsADirectoryError(final)
        fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX, suffix=TMP_SUFFIX, dir=parent)
        handle = os.fdopen(fd, "wb")
        try:
            for chunk in head:
                handle.write(chunk)
        except BaseException:
            handle.close()
            os.unlink(tmp)
            raise
        return Upload(handle, tmp, final)

    def write(self, key: str, head: list[bytes]) -> os.stat_result:
        """Write a stream that fit in memory in one step."""
        upload = self.begin_write(key, head)
        try:
            return upload.commit()
        except BaseException:
            upload.discard()
            raise

    def unlink(self, key: str) -> None:
        path = self._path(key)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return  # already absent is success
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise Unsupported(f"not a regular file: {key!r}")
        os.unlink(path)
