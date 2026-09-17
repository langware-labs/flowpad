"""``DriveSource`` — the files in Google Drive, My Drive or a shared drive.

Drive keeps a per-account change log, so this source walks it: a traversal from the beginning
enumerates once (``files.list``) and only THEN asks where the log starts — a file created while
the pages were walked is reported by the first delta rather than lost between the two calls —
and every traversal after that resumes from the durable cursor (``changes.list``). A removal is
REPORTED there, trashed or deleted, never inferred from absence.

The origin key is Drive's ``fileId``: it survives rename, move and content replacement. A
Google-native document has no bytes; ``open`` exports the three with an obvious text target and
the rest are not listed at all, because an asset that stands for nothing is worse than none.
Read-only by design — the scope asked for is ``drive.readonly``.
"""
from __future__ import annotations

import logging
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional
from urllib.parse import quote

import httpx
from pydantic import AwareDatetime

from flow_sdk.sources import http
from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, SourceError, SourceUnavailable
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery
from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

#: Drive's API root; ``config.base_url`` overrides it (a loopback server).
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
#: The one scope read with — named here because ``verify`` repeats it to the person.
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
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

_LIST = "list:"
_CHANGES = "changes:"
_NO_CREDENTIAL = "No Google credential on this machine. Connect Google, then verify the source."


class DriveQuery(DataQuery):
    """The files of one drive: a shared drive's id, or My Drive when empty."""

    spec_kind: ClassVar[str] = "source.query.gdrive"

    drive: str = ""


class DriveFileData(FileData):
    """A Drive file. ``drive_type`` is Drive's own type when ``open`` serves an export of it."""

    spec_kind: ClassVar[str] = "ingest.file.gdrive"

    modified_at: Optional[AwareDatetime] = None
    drive_type: Optional[str] = None


def safe_name(name: str) -> str:
    """A Drive name as ONE path component: Drive permits ``/`` and ``..`` in a name."""
    cleaned = name.replace("/", "_").replace("\\", "_").strip()
    return "_" if cleaned in {"", ".", ".."} else cleaned


def _servable(meta: dict) -> bool:
    """Whether a file has bytes ``open`` can give: not a folder, and not a native type with no export."""
    mime = str(meta.get("mimeType") or "")
    return bool(meta.get("id")) and not meta.get("trashed") and (not mime.startswith(NATIVE_PREFIX) or mime in EXPORT_TYPES)


class DriveConfig(SourceConfig):
    """What a gdrive source is configured with."""

    retired_list = ("drives", "drive")

    #: A shared drive's id — each has its own change log — or empty for My Drive. Never a folder:
    #: a file dragged out of one would fork.
    drive: str = ""
    cache_root: str = ""
    base_url: str = ""


class DriveSource(Source):

    Config = DriveConfig
    provider = "gdrive"
    reflects = True
    #: The change-log token is the only thing that says where the last traversal stopped.
    durable_cursor = True
    page_size = 100
    connection = "google"
    #: The cache is the application's and the next download overwrites it.
    stamps_identity = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._http: Optional[httpx.AsyncClient] = None

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

    async def _close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ── listing ─────────────────────────────────────────────────────────────
    def query(self) -> DriveQuery:
        """The configured shared drive, keyed on its id — a renamed drive is the same drive — else My Drive."""
        return DriveQuery(drive=str(self.config.get("drive") or "").strip())

    async def get(self, origin: CloudOrigin) -> Optional[FileItem]:
        self._require_open()
        key = self._scope.key(origin)
        params = {"fields": FILE_FIELDS, "supportsAllDrives": "true"}
        response = await self._request(f"/files/{quote(key, safe='')}", params, ok_statuses=(404,))
        if response.status_code == 404:
            return None
        meta = response.json()
        return self._item(meta) if _servable(meta) and meta.get("mimeType") != FOLDER_MIME else None

    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> ChangePage:
        self._require_open()
        query = self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        drive = _drive_params(query.drive)
        if cursor is None:
            return await self._list(drive, limit, None)
        if not isinstance(cursor, str):
            raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
        mode, _, token = cursor.partition(":")
        if not token:
            raise InvalidCursor("not a Drive cursor")
        if mode + ":" == _LIST:
            return await self._list(drive, limit, token)
        if mode + ":" == _CHANGES:
            return await self._changes(drive, limit, token)
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

    async def _list(self, drive: dict[str, str], limit: int, page_token: Optional[str]) -> ChangePage:
        params = {"q": "trashed = false", "fields": f"nextPageToken,files({FILE_FIELDS})", "pageSize": str(limit), **drive}
        if page_token:
            params["pageToken"] = page_token
        body = (await self._request("/files", params)).json()
        items = self._items(body.get("files") or ())
        if following := body.get("nextPageToken"):
            return ChangePage(items=items, next_cursor=_LIST + following)
        # AFTER the enumeration, never before: see the module docstring.
        start = (await self._request("/changes/startPageToken", dict(drive))).json()
        return ChangePage(items=items, resume_cursor=_CHANGES + str(start.get("startPageToken") or ""))

    async def _changes(self, drive: dict[str, str], limit: int, page_token: str) -> ChangePage:
        params = {
            "pageToken": page_token,
            "fields": f"nextPageToken,newStartPageToken,changes(fileId,removed,file({FILE_FIELDS}))",
            "pageSize": str(limit),
            **drive,
        }
        body = (await self._request("/changes", params)).json()
        changed: list[dict] = []
        removed: list[CloudOrigin] = []
        for change in body.get("changes") or ():
            meta = change.get("file") or {}
            file_id = str(change.get("fileId") or meta.get("id") or "")
            if change.get("removed") or meta.get("trashed"):
                if file_id:
                    removed.append(self.origin(file_id))
            else:
                changed.append(meta)
        items = self._items(changed)
        if following := body.get("nextPageToken"):
            return ChangePage(items=items, removed=tuple(removed), next_cursor=_CHANGES + following)
        return ChangePage(items=items, removed=tuple(removed), resume_cursor=_CHANGES + str(body.get("newStartPageToken") or page_token))

    def _items(self, files: Any) -> tuple[FileItem, ...]:
        files = [meta for meta in files if meta.get("mimeType") != FOLDER_MIME]
        servable = [meta for meta in files if _servable(meta)]
        if len(servable) < len(files):
            # Never a silent drop: a source that quietly lists 40 of 45 files reads as complete.
            logger.info("[gdrive] %s: skipped %d item(s) with no downloadable bytes", self.binding.source_id, len(files) - len(servable))
        return tuple(self._item(meta) for meta in servable)

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

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """Can this machine's Google credential read Drive? Everything else is config."""
        if self.credentials.token is None:
            return Verdict(ready=False, detail=_NO_CREDENTIAL)
        try:
            async with self:
                await self._request("/about", {"fields": "user(emailAddress)"})
        except SourceError as exc:
            return Verdict(ready=False, detail=f"Google refused the stored credential ({exc}). Reconnect Google, granting {DRIVE_SCOPE}.")
        return Verdict(ready=True)

    async def choices(self, field: str) -> list[dict]:
        """The shared drives this credential can see. A refusal raises: an empty list would read
        as "this account has no shared drives", which needs different words in the form."""
        if field != "drive":
            return []
        if self.credentials.token is None:
            raise AccessDenied("No Google credential on this machine. Connect Google first.")
        body = (await self._request("/drives", {"pageSize": "100", "fields": "drives(id,name)"})).json()
        return [{"id": str(d["id"]), "name": str(d.get("name") or d["id"])} for d in body.get("drives") or () if d.get("id")]

    # ── transport ───────────────────────────────────────────────────────────
    @property
    def _base(self) -> str:
        return str(self.config.get("base_url") or DRIVE_API_BASE).rstrip("/")

    def _auth(self) -> dict[str, str]:
        if self.credentials.token is None:
            raise AccessDenied(_NO_CREDENTIAL)
        return {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}

    async def _request(self, path: str, params: dict[str, str], **kwargs: Any) -> httpx.Response:
        self._require_open()
        assert self._http is not None
        return await http.request(self._http, "GET", f"{self._base}{path}", params=params, headers=self._auth(), **kwargs)

    def _item(self, meta: dict) -> FileItem:
        native = str(meta.get("mimeType") or "")
        export = EXPORT_TYPES.get(native)
        name = safe_name(str(meta.get("name") or meta["id"]))
        if export and not name.endswith(export[1]):
            name += export[1]
        size = meta.get("size")
        data = DriveFileData(
            name=name,
            path=name,
            media_type=export[0] if export else native or None,
            # An export's length is unknown until it is rendered.
            size=int(size) if size not in (None, "") and not export else None,
            modified_at=iso_to_utc(meta["modifiedTime"]) if meta.get("modifiedTime") else None,
            drive_type=native if export else None,
        )
        return FileItem(origin=self.origin(str(meta["id"])), data=data)


def _drive_params(drive: str) -> dict[str, str]:
    """The shared-drive half of every call, or nothing for My Drive."""
    if not drive:
        return {}
    return {"driveId": drive, "corpora": "drive", "includeItemsFromAllDrives": "true", "supportsAllDrives": "true"}


__all__ = ["DRIVE_API_BASE", "DRIVE_SCOPE", "EXPORT_TYPES", "DriveFileData", "DriveQuery", "DriveSource", "safe_name"]
