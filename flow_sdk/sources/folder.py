"""``FolderSource`` — the regular files beneath one existing local directory.

The generic local source, and the one that runs in-process: it reads this machine's own
tree and holds no provider credential. Origins are ``CloudOrigin("local", <root>, <key>)``,
built with ``origin(path)`` and no I/O; a rename is a new identity. Each file also reports what
the filesystem observed — its modification time and a ``<device>:<inode>`` handle — so an
application can notice an edit that kept the size and a rename within one volume.
"""

from __future__ import annotations

import os
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, AsyncIterator, BinaryIO, Callable, ClassVar, Optional

from pydantic import AwareDatetime

from flow_sdk.sources._paths import Folder, Upload, real_directory, relative_key
from flow_sdk.sources.base import Altitude, CollectionSource, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import FileDataPage
from flow_sdk.sources.values.query import ObjectQuery

DEFAULT_CHUNK_SIZE = 1 << 20
MAX_CHUNK_SIZE = 64 << 20
#: A stream at most this long is written in one worker-thread call.
WRITE_BUFFER = 1 << 20


class LocalFileData(FileData):
    """A file as this machine's filesystem reported it. Observations, never a revision."""

    spec_kind: ClassVar[str] = "ingest.file.local"

    modified_at: Optional[AwareDatetime] = None
    #: ``<device>:<inode>`` — the same file across a rename within one volume.
    handle: Optional[str] = None


class FolderSource(CollectionSource):
    provider = "folder"
    origin_kind = "local"
    altitude = Altitude.IN_PROCESS
    reflects = True
    supported_queries = (ObjectQuery,)
    page_type = FileDataPage
    #: Refuses a bare directory or file name; refused directories are never descended.
    skip: ClassVar[Optional[Callable[[str], bool]]] = None

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        """The root, canonical: ``~`` expanded and symlinks resolved, so every origin and every
        path this source hands out has one spelling (``/var`` is ``/private/var`` on macOS)."""
        root = binding.config.get("root")
        if not isinstance(root, str) or not root:
            raise ValueError("a folder source needs a 'root'")
        root = os.path.expanduser(root)
        if not os.path.isabs(root):
            raise ValueError(f"root must be an absolute path: {root!r}")
        return os.path.realpath(root)

    @classmethod
    def at(cls, root: str, **binding: Any) -> "FolderSource":
        """A source over ``root``, with no other configuration."""
        return cls(SourceBinding(config={"root": root}, **binding))

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._folder: Optional[Folder] = None
        self._streams: set[BinaryIO] = set()

    @property
    def root(self) -> str:
        return self._scope.namespace

    def origin(self, path: str) -> CloudOrigin:
        return self._scope.origin(relative_key(path))

    async def _open(self) -> None:
        real = await self._blocking(real_directory, self.root)
        if real is None:
            raise NotFound(f"folder does not exist: {self.root}")
        self._folder = Folder(real)

    async def _close(self) -> None:
        for handle in list(self._streams):
            handle.close()
        self._streams.clear()
        self._folder = None

    # ── read path ───────────────────────────────────────────────────────────
    async def _lookup(self, key: str) -> Optional[os.stat_result]:
        assert self._folder is not None
        return await self._blocking(self._folder.stat, key, origin=self._scope.origin(key))

    async def _scan(self, query: Optional[ObjectQuery]) -> list[tuple[str, os.stat_result]]:
        assert self._folder is not None
        return await self._blocking(self._folder.scan, "" if query is None else query.prefix, type(self).skip)

    def _item(self, key: str, st: os.stat_result) -> FileItem:
        data = LocalFileData(
            name=key.rpartition("/")[2],
            path=key,
            size=st.st_size,
            modified_at=datetime.fromtimestamp(st.st_mtime_ns / 1e9, timezone.utc),
            handle=f"{st.st_dev}:{st.st_ino}",
        )
        return FileItem(origin=self._scope.origin(key), data=data)

    def handle_of(self, item: FileItem) -> str:
        """The identity that survives a rename within one volume (``StableHandle``)."""
        return getattr(item.data, "handle", None) or ""

    # ── bytes ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = DEFAULT_CHUNK_SIZE) -> AbstractAsyncContextManager[AsyncIterator[bytes]]:
        if not isinstance(file, FileItem):
            raise TypeError(f"expected FileItem, got {type(file).__name__}")
        return self._reader(file.origin, positive_int(chunk_size, "chunk_size", MAX_CHUNK_SIZE))

    @asynccontextmanager
    async def _reader(self, origin: CloudOrigin, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        self._require_open()
        assert self._folder is not None
        key = self._scope.key(origin)
        handle, first = await self._blocking(self._folder.open_read, key, chunk_size, origin=origin, undo=_close_opened)
        if handle is not None:
            self._streams.add(handle)
        try:
            yield self._chunks(handle, first, chunk_size, origin)
        finally:
            self._release(handle)

    async def _chunks(
        self, handle: Optional[BinaryIO], first: bytes, chunk_size: int, origin: CloudOrigin
    ) -> AsyncGenerator[bytes, None]:
        if first:
            yield first
        while handle is not None:
            if handle.closed:
                raise RuntimeError("stream is closed")
            chunk = await self._blocking(handle.read, chunk_size, origin=origin)
            if chunk:
                yield chunk
            if len(chunk) < chunk_size:
                self._release(handle)
                return

    def _release(self, handle: Optional[BinaryIO]) -> None:
        if handle is not None:
            self._streams.discard(handle)
            handle.close()

    async def write(self, path: str, content: AsyncIterator[bytes]) -> FileItem:
        self._require_open()
        assert self._folder is not None
        key = relative_key(path)
        origin = self._scope.origin(key)
        chunks = aiter(content)
        head, exhausted = await _read_ahead(chunks)
        if exhausted:
            return self._item(key, await self._blocking(self._folder.write, key, head, origin=origin))
        upload = await self._blocking(self._folder.begin_write, key, head, origin=origin, undo=Upload.discard)
        try:
            async for chunk in chunks:
                await self._blocking(upload.handle.write, _bytes(chunk), origin=origin)
            st = await self._blocking(upload.commit, origin=origin)
        except BaseException:
            upload.discard()
            raise
        return self._item(key, st)

    async def delete(self, origin: CloudOrigin) -> None:
        self._require_open()
        assert self._folder is not None
        await self._blocking(self._folder.unlink, self._scope.key(origin), origin=origin)


def _close_opened(opened: tuple[Optional[BinaryIO], bytes]) -> None:
    if opened[0] is not None:
        opened[0].close()


async def _read_ahead(chunks: AsyncIterator[bytes]) -> tuple[list[bytes], bool]:
    """Buffer up to ``WRITE_BUFFER`` bytes; report whether the stream ended within them."""
    head: list[bytes] = []
    buffered = 0
    while buffered < WRITE_BUFFER:
        try:
            chunk = _bytes(await anext(chunks))
        except StopAsyncIteration:
            return head, True
        head.append(chunk)
        buffered += len(chunk)
    return head, False


def _bytes(chunk: object) -> bytes:
    if type(chunk) is not bytes:
        raise TypeError(f"content chunks must be bytes, got {type(chunk).__name__}")
    return chunk


__all__ = ["DEFAULT_CHUNK_SIZE", "MAX_CHUNK_SIZE", "FolderSource", "LocalFileData"]
