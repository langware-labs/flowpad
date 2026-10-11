"""``DriveSource`` — the files in Google Drive: a folder of it, My Drive or a shared drive; read and written.

Drive keeps a per-account change log, so this source walks it: a traversal from the beginning
enumerates once and only THEN asks where the log starts — a file created while the pages were walked
is reported by the first delta rather than lost between the two calls — and every traversal after that
resumes from the durable cursor (``changes.list``). A removal is REPORTED there, trashed or deleted,
never inferred from absence.

**Scope.** ``path`` ("GTM/Research") names a folder of the drive; empty is the whole drive. A scoped
source enumerates its folder breadth first; the change log is drive-wide, so a change is placed by
walking the file's parents up to the scope — one outside it is reported removed (the application
ignores a removal of a file it never placed), so a file dragged out leaves and one dragged in arrives.
A folder renamed or moved re-reports what is under it, at its new paths.

**Paths are Drive's own folders**, each name reduced to one safe path component, so the local copy
mirrors the tree. The origin key is Drive's ``fileId``: it survives rename, move and content
replacement. A Google-native document has no bytes; ``open`` exports the three with an obvious text
target and the rest are not listed at all, because an asset that stands for nothing is worse than none.

**Writes** (``ByteStore``) land under the scope: missing folders are created, a file of that name is
updated in place (so its ``fileId`` and sharing survive), and ``delete`` moves to Drive's TRASH — never
a permanent delete, so a mistake is one click from undone. An export of a native document is not
writable: writing it back would replace a Doc with a markdown file. A read-only source
(``binding.read_only``) refuses every write before any I/O.
"""
from __future__ import annotations

import base64
import json
import logging
import mimetypes
import uuid
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional
from urllib.parse import quote

import httpx
from pydantic import AwareDatetime

from flow_sdk.sources import http
from flow_sdk.sources._paths import relative_key
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
    is_transient,
)
from flow_sdk.sources.families import ObjectSource
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery
from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

#: Google's own API root. Every other root the driver talks to is derived from the EFFECTIVE one, so a
#: loopback server (``config.base_url``, or ``DRIVE_API_BASE`` patched) receives every call.
GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3"
#: Drive's API root; ``config.base_url`` overrides it (a loopback server).
DRIVE_API_BASE = GOOGLE_DRIVE_API
#: Where bytes go up. With a ``base_url`` override it is derived from it (``_upload_base``).
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
#: The scope a read-only source reads with — named here because ``verify`` repeats it to the person.
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
#: The scope writing back needs (``permission.google.drive.write``).
DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive"
#: Where a token says what it was granted.
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
#: Google-native types with a lossless-enough text target, and what ``open`` exports them as.
EXPORT_TYPES = {
    "application/vnd.google-apps.document": ("text/markdown", ".md"),
    "application/vnd.google-apps.spreadsheet": ("text/csv", ".csv"),
    "application/vnd.google-apps.presentation": ("text/plain", ".txt"),
}
NATIVE_PREFIX = "application/vnd.google-apps."
FOLDER_MIME = "application/vnd.google-apps.folder"
#: Only what is read: Drive bills fields, and nothing can come to depend on one never asked for.
FILE_FIELDS = "id,name,mimeType,modifiedTime,size,parents,trashed"
DEFAULT_CHUNK_SIZE = 1 << 20
MAX_CHUNK_SIZE = 64 << 20
#: Up to this a write is one multipart request; above it, a resumable upload session.
MULTIPART_LIMIT = 5 << 20
#: A parents chain longer than this is a cycle or a bug, not a folder tree.
MAX_DEPTH = 64

_LIST = "list:"
_WALK = "walk:"
_CHANGES = "changes:"
_NO_CREDENTIAL = "No Google credential on this machine. Connect Google, then verify the source."


class DriveQuery(DataQuery):
    """The files of one drive (a shared drive's id, or My Drive when empty) under ``path``."""

    spec_kind: ClassVar[str] = "source.query.gdrive"

    drive: str = ""
    path: str = ""


class DriveFileData(FileData):
    """A Drive file. ``drive_type`` is Drive's own type when ``open`` serves an export of it."""

    spec_kind: ClassVar[str] = "ingest.file.gdrive"

    modified_at: Optional[AwareDatetime] = None
    drive_type: Optional[str] = None


def safe_name(name: str) -> str:
    """A Drive name as ONE path component: Drive permits ``/`` and ``..`` in a name."""
    cleaned = name.replace("/", "_").replace("\\", "_").strip()
    return "_" if cleaned in {"", ".", ".."} else cleaned


def _segments(path: str) -> list[str]:
    return [part for part in str(path or "").replace("\\", "/").split("/") if part.strip()]


def _quoted(value: str) -> str:
    """``value`` as a string literal of Drive's query language."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _servable(meta: dict) -> bool:
    """Whether a file has bytes ``open`` can give: not a folder, and not a native type with no export."""
    mime = str(meta.get("mimeType") or "")
    return bool(meta.get("id")) and not meta.get("trashed") and (not mime.startswith(NATIVE_PREFIX) or mime in EXPORT_TYPES)


async def _collect(content: AsyncIterator[bytes]) -> bytes:
    """The whole stream, refusing a chunk that is not bytes."""
    parts: list[bytes] = []
    async for chunk in content:
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError(f"content must yield bytes, got {type(chunk).__name__}")
        parts.append(bytes(chunk))
    return b"".join(parts)


class DriveConfig(SourceConfig):
    """What a gdrive source is configured with."""

    retired_list = ("drives", "drive")

    #: A shared drive's id — each has its own change log — or empty for My Drive.
    drive: str = ""
    #: A folder of that drive ("GTM/Research"); empty is the whole drive.
    path: str = ""
    cache_root: str = ""
    base_url: str = ""


class DriveSource(ObjectSource):

    Config = DriveConfig
    provider = "gdrive"
    #: The change-log token is the only thing that says where the last traversal stopped.
    durable_cursor = True
    page_size = 100
    connection = "google"
    #: The cache is the application's and the next download overwrites it.
    stamps_identity = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._http: Optional[httpx.AsyncClient] = None
        #: Folder metadata seen this session, by id — a path is a walk up these.
        self._folders: dict[str, dict] = {}
        self._scope_id: Optional[str] = None

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        """A ``fileId`` is Drive-wide; the account (else the row) scopes it."""
        return binding.account_key or binding.source_id or cls.provider

    @classmethod
    def changes_from(cls, page_token: str) -> str:
        """The cursor that resumes the change log at ``page_token``."""
        return _CHANGES + page_token

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def origin_id_for(cls, row: Any, ref: str, root: Any) -> str:
        """``gdrive:<fileId>`` for a cached file, read out of the index the engine keeps beside the
        cache — a ``fileId`` survives rename, move and content replacement, which neither a path nor
        an inode can promise. A file the index does not know falls back to its path."""
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.ingest.driver_runtime import read_cache_index  # noqa: PLC0415

        rel = Path(ref).resolve().relative_to(Path(root)).as_posix()
        key = read_cache_index(Path(root), cls.provider).get(rel)
        return f"{cls.provider}:{key}" if key else ""

    async def _open(self) -> None:
        self._http = http.client()
        self._folders, self._scope_id = {}, None

    async def _close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ── scope ───────────────────────────────────────────────────────────────
    def query(self) -> DriveQuery:
        """The configured shared drive, keyed on its id — a renamed drive is the same drive — else My
        Drive, and the folder of it."""
        return DriveQuery(drive=self._drive_id, path="/".join(_segments(self.config.get("path") or "")))

    @property
    def _drive_id(self) -> str:
        """The configured shared drive's id, or ``""`` for My Drive."""
        return str(self.config.get("drive") or "").strip()

    @property
    def _drive_root(self) -> str:
        """The id the drive's top folder answers to in a query: the shared drive's id, or ``root``."""
        return self._drive_id or "root"

    async def _scope_root(self) -> Optional[str]:
        """The folder ``path`` names, resolved by name from the drive's top; None for the whole drive.
        A missing folder is ``NotFound``; two folders of one name are ``Rejected`` — never a guess."""
        segments = _segments(self.config.get("path") or "")
        if not segments:
            return None
        if self._scope_id is not None:
            return self._scope_id
        parent, walked = self._drive_root, []
        for segment in segments:
            walked.append(segment)
            found = await self._children(parent, name=segment, folders=True)
            if not found:
                raise NotFound(f"Drive has no folder {'/'.join(walked)!r}")
            if len(found) > 1:
                ids = ", ".join(f["id"] for f in found)
                raise Rejected(f"Drive has {len(found)} folders named {'/'.join(walked)!r} ({ids}); rename one")
            parent = found[0]["id"]
            self._folders[parent] = found[0]
        self._scope_id = parent
        return parent

    async def _children(
        self, parent: str, *, name: Optional[str] = None, folders: Optional[bool] = None, trashed: bool = False,
        page_token: Optional[str] = None, page_size: int = 100,
    ) -> list[dict]:
        """The children of ``parent`` matching, every page (or one page when ``page_token`` is given)."""
        body = await self._list_page(parent, name=name, folders=folders, trashed=trashed, page_token=page_token, page_size=page_size)
        files = list(body.get("files") or ())
        while page_token is None and (following := body.get("nextPageToken")):
            body = await self._list_page(parent, name=name, folders=folders, trashed=trashed, page_token=following, page_size=page_size)
            files.extend(body.get("files") or ())
        return files

    async def _list_page(
        self, parent: Optional[str], *, name: Optional[str] = None, folders: Optional[bool] = None, trashed: bool = False,
        page_token: Optional[str] = None, page_size: int = 100,
    ) -> dict:
        """One ``files.list`` page: the children of ``parent`` (every file of the drive when None) that match."""
        terms = [f"{_quoted(parent)} in parents"] if parent else []
        if not trashed:
            terms.append("trashed = false")
        if name is not None:
            terms.append(f"name = {_quoted(name)}")
        if folders is True:
            terms.append(f"mimeType = {_quoted(FOLDER_MIME)}")
        elif folders is False:
            terms.append(f"mimeType != {_quoted(FOLDER_MIME)}")
        params = {"q": " and ".join(terms), "fields": f"nextPageToken,files({FILE_FIELDS})", "pageSize": str(page_size), **self._drive_params()}
        if page_token:
            params["pageToken"] = page_token
        return (await self._request("GET", "/files", params)).json()

    async def _folder(self, folder_id: str) -> Optional[dict]:
        """A folder's metadata, once per session; None when it cannot be read (not shared with us)."""
        if folder_id not in self._folders:
            response = await self._request(
                "GET", f"/files/{quote(folder_id, safe='')}", {"fields": FILE_FIELDS, "supportsAllDrives": "true"}, ok_statuses=(403, 404),
            )
            self._folders[folder_id] = response.json() if response.status_code < 400 else {}
        return self._folders[folder_id] or None

    async def _path_of(self, meta: dict) -> Optional[str]:
        """``meta``'s path under the scope, each name one safe component; None when it is outside.

        For the whole drive, a file whose parents cannot be read (shared with us, its folder not) sits
        at the top. A scoped source is stricter: only what is provably under its folder is its own."""
        scope = await self._scope_root()
        parts = [safe_name(str(meta.get("name") or meta.get("id") or ""))]
        parents = list(meta.get("parents") or ())
        for _ in range(MAX_DEPTH):
            if not parents:
                return "/".join(reversed(parts)) if scope is None else None
            parent = parents[0]
            if parent == scope or (scope is None and parent == self._drive_root):
                return "/".join(reversed(parts))
            folder = await self._folder(parent)
            if folder is None or folder.get("trashed"):
                return "/".join(reversed(parts)) if scope is None and folder is None else None
            parents = list(folder.get("parents") or ())
            if not parents and scope is None:
                return "/".join(reversed(parts))  # the drive's own top folder: not part of the path
            parts.append(safe_name(str(folder.get("name") or parent)))
        logger.warning("[gdrive] %s: parents of %s are deeper than %d", self.binding.source_id, meta.get("id"), MAX_DEPTH)
        return None

    # ── listing ─────────────────────────────────────────────────────────────
    async def get(self, origin: CloudOrigin) -> Optional[FileItem]:
        self._require_open()
        key = self._scope.key(origin)
        params = {"fields": FILE_FIELDS, "supportsAllDrives": "true"}
        response = await self._request("GET", f"/files/{quote(key, safe='')}", params, ok_statuses=(404,))
        if response.status_code == 404:
            return None
        meta = response.json()
        if not _servable(meta) or meta.get("mimeType") == FOLDER_MIME:
            return None
        path = await self._path_of(meta)
        return self._item(meta, path) if path is not None else None

    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> ChangePage:
        self._require_open()
        self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        if cursor is None:
            return await self._list(limit, None) if await self._scope_root() is None else await self._walk(limit, None)
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        mode, _, token = cursor.partition(":")
        if not token:
            raise InvalidCursor("not a Drive cursor")
        if mode + ":" == _LIST:
            return await self._list(limit, token)
        if mode + ":" == _WALK:
            return await self._walk(limit, _walk_state(token))
        if mode + ":" == _CHANGES:
            return await self._changes(limit, token)
        raise InvalidCursor("not a Drive cursor")

    async def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncGenerator[FileItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(cursor, page_size=page_size, narrow=narrow)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    async def _start(self) -> str:
        """Where the change log starts — asked AFTER the enumeration, never before (module docstring)."""
        start = (await self._request("GET", "/changes/startPageToken", self._drive_params())).json()
        return _CHANGES + str(start.get("startPageToken") or "")

    async def _list(self, limit: int, page_token: Optional[str]) -> ChangePage:
        """The whole drive, one ``files.list`` page at a time."""
        body = await self._list_page(None, page_token=page_token, page_size=limit)
        files = list(body.get("files") or ())
        self._remember_folders(files)
        items = await self._items(files)
        if following := body.get("nextPageToken"):
            return ChangePage(items=items, next_cursor=_LIST + following)
        return ChangePage(items=items, resume_cursor=await self._start())

    async def _walk(self, limit: int, state: Optional[dict]) -> ChangePage:
        """The scope folder, breadth first: one page of one folder's children per call. The queue of
        folders still to list rides the cursor, so a page needs nothing remembered."""
        if state is None:
            state = {"queue": [[await self._scope_root(), ""]], "token": ""}
        (folder_id, rel), *rest = state["queue"]
        body = await self._list_page(folder_id, page_token=state["token"] or None, page_size=limit)
        files, queue = list(body.get("files") or ()), rest
        self._remember_folders(files)
        for meta in files:
            if meta.get("mimeType") == FOLDER_MIME:
                queue.append([meta["id"], f"{rel}/{safe_name(str(meta.get('name') or meta['id']))}".lstrip("/")])
        items = self._placed(files, rel)
        if following := body.get("nextPageToken"):
            return ChangePage(items=items, next_cursor=_WALK + _walk_token({"queue": [[folder_id, rel], *rest], "token": following}))
        if queue:
            return ChangePage(items=items, next_cursor=_WALK + _walk_token({"queue": queue, "token": ""}))
        return ChangePage(items=items, resume_cursor=await self._start())

    async def _changes(self, limit: int, page_token: str) -> ChangePage:
        params = {
            "pageToken": page_token,
            "fields": f"nextPageToken,newStartPageToken,changes(fileId,removed,file({FILE_FIELDS}))",
            "pageSize": str(limit),
            **self._drive_params(),
        }
        body = (await self._request("GET", "/changes", params)).json()
        changed: list[dict] = []
        removed: list[CloudOrigin] = []
        for change in body.get("changes") or ():
            meta = change.get("file") or {}
            file_id = str(change.get("fileId") or meta.get("id") or "")
            if meta.get("mimeType") == FOLDER_MIME:
                # A folder moved, renamed or trashed: what is under it moves with it, and the log says
                # nothing about those files — so they are re-reported (or removed) from here.
                self._folders[file_id] = meta
                moved, gone = await self._under_folder(meta, removed=bool(change.get("removed") or meta.get("trashed")))
                changed.extend(moved)
                removed.extend(gone)
            elif change.get("removed") or meta.get("trashed"):
                if file_id:
                    removed.append(self.origin(file_id))
            else:
                changed.append(meta)
        items: list[FileItem] = []
        for meta in changed:
            if not _servable(meta):
                continue
            path = await self._path_of(meta)
            if path is None:
                removed.append(self.origin(str(meta["id"])))  # outside the scope now: it left
            else:
                items.append(self._item(meta, path))
        if following := body.get("nextPageToken"):
            return ChangePage(items=tuple(items), removed=tuple(removed), next_cursor=_CHANGES + following)
        return ChangePage(items=tuple(items), removed=tuple(removed), resume_cursor=_CHANGES + str(body.get("newStartPageToken") or page_token))

    async def _under_folder(self, folder: dict, *, removed: bool) -> tuple[list[dict], list[CloudOrigin]]:
        """Every file under ``folder``: as changed metadata when the folder is still (or newly) in the
        scope, as removals when it is trashed or left it."""
        gone = removed or (await self._path_of(folder)) is None
        files: list[dict] = []
        pending = [str(folder["id"])]
        while pending:
            for meta in await self._children(pending.pop(), trashed=gone):
                if meta.get("mimeType") == FOLDER_MIME:
                    self._folders[meta["id"]] = meta
                    pending.append(meta["id"])
                else:
                    files.append(meta)
        if gone:
            return [], [self.origin(str(m["id"])) for m in files]
        return files, []

    def _remember_folders(self, files: Any) -> None:
        for meta in files:
            if meta.get("mimeType") == FOLDER_MIME and meta.get("id"):
                self._folders[meta["id"]] = meta

    def _servable_files(self, files: Any) -> list[dict]:
        files = [meta for meta in files if meta.get("mimeType") != FOLDER_MIME]
        servable = [meta for meta in files if _servable(meta)]
        if len(servable) < len(files):
            # Never a silent drop: a source that quietly lists 40 of 45 files reads as complete.
            logger.info("[gdrive] %s: skipped %d item(s) with no downloadable bytes", self.binding.source_id, len(files) - len(servable))
        return servable

    def _placed(self, files: Any, rel: str) -> tuple[FileItem, ...]:
        """The files of one folder whose path under the scope is ``rel``."""
        return tuple(self._item(meta, f"{rel}/{self._local_name(meta)}".lstrip("/")) for meta in self._servable_files(files))

    async def _items(self, files: Any) -> tuple[FileItem, ...]:
        out = []
        for meta in self._servable_files(files):
            path = await self._path_of(meta)
            if path is not None:
                out.append(self._item(meta, path))
        return tuple(out)

    # ── bytes ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = DEFAULT_CHUNK_SIZE) -> AbstractAsyncContextManager[AsyncIterator[bytes]]:
        if not isinstance(file, FileItem):
            raise TypeError(f"expected FileItem, got {type(file).__name__}")
        return self._reader(file, positive_int(chunk_size, "chunk_size", MAX_CHUNK_SIZE))

    @asynccontextmanager
    async def _reader(self, file: FileItem, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        self._require_open()
        assert self._http is not None
        file_id = quote(self._scope.key(file.origin), safe="")
        export = EXPORT_TYPES.get(getattr(file.data, "drive_type", None) or "")
        path, params = (f"/files/{file_id}/export", {"mimeType": export[0]}) if export else (f"/files/{file_id}", {"alt": "media", "supportsAllDrives": "true"})
        url = f"{self._base}{path}"
        try:
            async with self._http.stream("GET", url, params=params, headers=self._auth()) as response:
                if response.status_code >= 400:
                    raise http.error_for_status(response.status_code, origin=file.origin)
                yield response.aiter_bytes(chunk_size)
        except httpx.HTTPError as exc:
            raise SourceUnavailable(f"GET {url}: {exc}", origin=file.origin) from exc

    async def write(self, path: str, content: AsyncIterator[bytes]) -> FileItem:
        """Write ``content`` at ``path`` under the scope: missing folders are created, a file of that
        name is updated in place (its ``fileId`` and sharing survive), else one is created."""
        self._require_open()
        key = relative_key(path)
        self._require_writable()
        data = await _collect(content)
        *folders, leaf = key.split("/")
        parent = await self._ensure_folders(folders)
        existing = await self._children(parent, name=leaf, folders=False)
        if not existing and (stem := _export_stem(leaf)) is not None:
            if [m for m in await self._children(parent, name=stem, folders=False) if m.get("mimeType") in EXPORT_TYPES]:
                raise Unsupported(f"{key} is an export of a Google document; edit it in Drive", origin=self.origin(key))
        if len(existing) > 1:
            raise Rejected(f"Drive has {len(existing)} files named {key!r}; rename one", origin=self.origin(key))
        if existing:
            meta = existing[0]
            if str(meta.get("mimeType") or "").startswith(NATIVE_PREFIX):
                raise Unsupported(f"{key} is a Google document; edit it in Drive", origin=self.origin(str(meta["id"])))
            meta = await self._upload_content(str(meta["id"]), data)
        else:
            meta = await self._create(parent, leaf, data)
        return self._item(meta, key)

    async def delete(self, origin: CloudOrigin) -> None:
        """Move the file to Drive's trash, then each folder that left empty, up to — never including — the
        scope folder: a removed row leaves no empty folder behind. Already gone is success."""
        self._require_open()
        self._require_writable()
        trashed = await self._trash(self._scope.key(origin), origin=origin)
        stop = {await self._scope_root() or self._drive_root, self._drive_root}
        parent = next(iter((trashed or {}).get("parents") or ()), None)
        for _ in range(MAX_DEPTH):
            if not parent or parent in stop or (await self._list_page(parent, page_size=1)).get("files"):
                return
            self._folders.pop(parent, None)
            parent = next(iter((await self._trash(parent) or {}).get("parents") or ()), None)

    async def _trash(self, file_id: str, *, origin: Optional[CloudOrigin] = None) -> Optional[dict]:
        """Move one file or folder to the trash; its ``{id, parents}``, or None when it was already gone."""
        response = await self._request(
            "PATCH", f"/files/{quote(file_id, safe='')}", {"supportsAllDrives": "true", "fields": "id,parents"},
            json={"trashed": True}, ok_statuses=(404,), origin=origin,
        )
        return None if response.status_code == 404 else response.json()

    async def _ensure_folders(self, folders: list[str]) -> str:
        """The folder ``folders`` names under the scope, created where missing."""
        parent = await self._scope_root() or self._drive_root
        for name in folders:
            found = await self._children(parent, name=name, folders=True)
            if len(found) > 1:
                raise Rejected(f"Drive has {len(found)} folders named {name!r} in one place; rename one")
            if found:
                parent = found[0]["id"]
                continue
            created = (await self._request(
                "POST", "/files", {"supportsAllDrives": "true", "fields": FILE_FIELDS},
                json={"name": name, "mimeType": FOLDER_MIME, "parents": [parent]},
            )).json()
            self._folders[created["id"]] = created
            parent = created["id"]
        return parent

    async def _create(self, parent: str, name: str, data: bytes) -> dict:
        metadata = {"name": name, "parents": [parent]}
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        params = {"supportsAllDrives": "true", "fields": FILE_FIELDS}
        if len(data) <= MULTIPART_LIMIT:
            boundary = f"flowpad-{uuid.uuid4().hex}"
            body = (
                f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(metadata)}\r\n"
                f"--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
            ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
            response = await self._request(
                "POST", "/files", {**params, "uploadType": "multipart"}, upload=True,
                content=body, headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            )
            return response.json()
        session = await self._request(
            "POST", "/files", {**params, "uploadType": "resumable"}, upload=True, json=metadata,
            headers={"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(len(data))},
        )
        location = session.headers.get("Location")
        if not location:
            raise SourceUnavailable("Drive opened no upload session")
        return (await self._send("PUT", location, content=data, headers={"Content-Type": mime})).json()

    async def _upload_content(self, file_id: str, data: bytes) -> dict:
        response = await self._request(
            "PATCH", f"/files/{quote(file_id, safe='')}", {"uploadType": "media", "supportsAllDrives": "true", "fields": FILE_FIELDS},
            upload=True, content=data, origin=self.origin(file_id),
        )
        return response.json()

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """Can this machine's Google credential read Drive, and is the configured folder there?"""
        if self.credentials.token is None:
            return Verdict(ready=False, detail=_NO_CREDENTIAL)
        try:
            async with self:
                await self._request("GET", "/about", {"fields": "user(emailAddress)"})
                await self._scope_root()
                if not self.binding.read_only and DRIVE_WRITE_SCOPE not in await self._granted_scopes():
                    return Verdict(ready=False, detail=(
                        "This source writes back to Drive, and the Google connection can only read. "
                        "Reconnect Google (Connections → Google → Reconnect) to grant write access, "
                        "or make the source read-only."
                    ))
        except (NotFound, Rejected) as exc:
            return Verdict(ready=False, detail=f"{exc}. Fix the folder path, then verify the source.")
        except SourceError as exc:
            if is_transient(exc):
                raise  # the provider did not answer: that says nothing about the setup
            scope = DRIVE_SCOPE if self.binding.read_only else DRIVE_WRITE_SCOPE
            return Verdict(ready=False, detail=f"Google refused the stored credential ({exc}). Reconnect Google, granting {scope}.")
        return Verdict(ready=True)

    async def _granted_scopes(self) -> set[str]:
        """The scopes the held token actually carries — Google's own answer (``tokeninfo``)."""
        url = TOKENINFO_URL if self._base == GOOGLE_DRIVE_API else f"{self._base}/tokeninfo"
        token = self.credentials.token.get_secret_value() if self.credentials.token is not None else ""
        assert self._http is not None
        response = await http.request(self._http, "GET", url, params={"access_token": token}, ok_statuses=(400,))
        return set(str(response.json().get("scope") or "").split()) if response.status_code < 400 else set()

    async def choices(self, field: str) -> list[dict]:
        """The shared drives this credential can see. A refusal raises: an empty list would read
        as "this account has no shared drives", which needs different words in the form."""
        if field != "drive":
            return []
        if self.credentials.token is None:
            raise AccessDenied("No Google credential on this machine. Connect Google first.")
        body = (await self._request("GET", "/drives", {"pageSize": "100", "fields": "drives(id,name)"})).json()
        return [{"id": str(d["id"]), "name": str(d.get("name") or d["id"])} for d in body.get("drives") or () if d.get("id")]

    # ── transport ───────────────────────────────────────────────────────────
    @property
    def _base(self) -> str:
        return str(self.config.get("base_url") or DRIVE_API_BASE).rstrip("/")

    @property
    def _upload_base(self) -> str:
        """Drive's upload root, next to the API root it is derived from (``/drive/v3`` → ``/upload/drive/v3``)."""
        base = self._base
        if base == GOOGLE_DRIVE_API:
            return DRIVE_UPLOAD_BASE
        return base.replace("/drive/v3", "/upload/drive/v3") if base.endswith("/drive/v3") else f"{base}/upload"

    def _drive_params(self) -> dict[str, str]:
        """The shared-drive half of every listing call, or nothing for My Drive."""
        if not self._drive_id:
            return {}
        return {"driveId": self._drive_id, "corpora": "drive", "includeItemsFromAllDrives": "true", "supportsAllDrives": "true"}

    def _auth(self) -> dict[str, str]:
        if self.credentials.token is None:
            raise AccessDenied(_NO_CREDENTIAL)
        return {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}

    async def _request(
        self, method: str, path: str, params: dict[str, str], *, upload: bool = False, headers: Optional[dict] = None, **kwargs: Any,
    ) -> httpx.Response:
        self._require_open()
        root = self._upload_base if upload else self._base
        return await self._send(method, f"{root}{path}", params=params, headers=headers, **kwargs)

    async def _send(self, method: str, url: str, *, headers: Optional[dict] = None, **kwargs: Any) -> httpx.Response:
        assert self._http is not None
        return await http.request(self._http, method, url, headers={**self._auth(), **(headers or {})}, **kwargs)

    def _local_name(self, meta: dict) -> str:
        export = EXPORT_TYPES.get(str(meta.get("mimeType") or ""))
        name = safe_name(str(meta.get("name") or meta["id"]))
        return name + export[1] if export and not name.endswith(export[1]) else name

    def _item(self, meta: dict, path: str) -> FileItem:
        native = str(meta.get("mimeType") or "")
        export = EXPORT_TYPES.get(native)
        name = self._local_name(meta)
        if export and not path.endswith(export[1]):
            path += export[1]
        size = meta.get("size")
        data = DriveFileData(
            name=name,
            path=path,
            media_type=export[0] if export else native or None,
            # An export's length is unknown until it is rendered.
            size=int(size) if size not in (None, "") and not export else None,
            modified_at=iso_to_utc(meta["modifiedTime"]) if meta.get("modifiedTime") else None,
            drive_type=native if export else None,
        )
        return FileItem(origin=self.origin(str(meta["id"])), data=data)


def _export_stem(leaf: str) -> Optional[str]:
    """``notes`` for ``notes.md`` — the native document a local export would stand for."""
    for _media, ext in EXPORT_TYPES.values():
        if leaf.endswith(ext) and len(leaf) > len(ext):
            return leaf[: -len(ext)]
    return None


def _walk_token(state: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode()


def _walk_state(token: str) -> dict:
    try:
        state = json.loads(base64.urlsafe_b64decode(token.encode()))
    except (ValueError, TypeError) as exc:
        raise InvalidCursor("malformed Drive cursor") from exc
    queue = state.get("queue") if isinstance(state, dict) else None
    if not isinstance(queue, list) or not queue or not all(isinstance(e, list) and len(e) == 2 for e in queue):
        raise InvalidCursor("malformed Drive cursor")
    return {"queue": queue, "token": str(state.get("token") or "")}


__all__ = [
    "DRIVE_API_BASE", "DRIVE_SCOPE", "DRIVE_UPLOAD_BASE", "DRIVE_WRITE_SCOPE", "EXPORT_TYPES",
    "DriveFileData", "DriveQuery", "DriveSource", "safe_name",
]
