"""``GcsSource`` — the objects in a Google Cloud Storage bucket.

GCS has no change log: it answers "what is in this bucket now". So a traversal is one
authoritative enumeration and the application diffs it — absence from a complete listing IS
deletion, which a feed's silence never is. There is no move either: a "rename" is a copy plus a
delete, and that is what arrives. The origin is ``(gcs, <bucket>, <object name>)``; a name is
the identity and survives a new ``generation``, so no handle is offered to guess a rename with.

Read-only by design — the scope asked for is ``devstorage.read_only`` — so the bytes are served
through ``open`` and nothing writes back. Where the bytes land is the application's business.
"""
from __future__ import annotations

from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, AsyncGenerator, AsyncIterator, ClassVar, Optional
from urllib.parse import quote

import httpx
from pydantic import AwareDatetime

from flow_sdk.sources import _paging, http
from flow_sdk.sources.base import Source, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import AccessDenied, Rejected, SourceError, SourceUnavailable, Unsupported
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, FileDataPage
from flow_sdk.sources.values.query import DataQuery, ObjectQuery
from flow_sdk.sources.values.segment import SegmentRef
from flow_sdk.utils.serialization import iso_to_utc

#: The JSON API root; ``config.base_url`` overrides it (a loopback server, an emulator).
GCS_API_BASE = "https://storage.googleapis.com/storage/v1"
#: The one scope read with — named here because ``verify`` repeats it to the person.
GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only"
#: The segment key of the whole bucket, when no prefix is configured.
ROOT_SEGMENT = "/"
#: Only what is read, so nothing can come to depend on a field the query never asked for.
OBJECT_FIELDS = "name,generation,size,updated,contentType"
DEFAULT_CHUNK_SIZE = 1 << 20
MAX_CHUNK_SIZE = 64 << 20

_NO_CREDENTIAL = "No Google credential on this machine. Connect Google, then verify the source."


class GcsObjectData(FileData):
    """An object as the listing reported it. ``generation`` moves exactly when the bytes do."""

    spec_kind: ClassVar[str] = "ingest.file.gcs"

    generation: Optional[str] = None
    updated_at: Optional[AwareDatetime] = None


class GcsSource(Source):
    provider = "gcs"
    reflects = True
    page_size = MAX_PAGE_SIZE
    connection = "google"
    identity_config_key = "bucket"
    #: The cache is the application's and the next download overwrites it: a stamped capsule
    #: would last until the object changed upstream.
    stamps_identity = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._http: Optional[httpx.AsyncClient] = None

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        # Not refused here: the picker opens a source to LIST buckets before one is chosen.
        return _bucket_name(binding.config) or cls.provider

    @property
    def bucket(self) -> str:
        name = _bucket_name(self.config)
        if not name:
            raise Rejected("config.bucket is not set")
        return name

    async def _open(self) -> None:
        self._http = http.client()

    async def _close(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ── listing ─────────────────────────────────────────────────────────────
    async def segments(self) -> list[SegmentRef]:
        """One per configured prefix, else the whole bucket. A prefix is a query, never a
        directory, so keying a cursor on one cannot fork an object's identity."""
        prefixes = [str(p).strip() for p in self.config.get("prefixes") or [] if str(p).strip()]
        if not prefixes:
            return [SegmentRef(key=ROOT_SEGMENT, label=self.bucket, query=ObjectQuery())]
        return [SegmentRef(key=p, label=p, query=ObjectQuery(prefix=p)) for p in prefixes]

    async def get(self, origin: CloudOrigin) -> Optional[FileItem]:
        self._require_open()
        key = self._scope.key(origin)
        response = await self._request(self._object_path(key), {"fields": OBJECT_FIELDS}, ok_statuses=(404,))
        return None if response.status_code == 404 else self._item(response.json())

    async def fetch(self, query: Optional[DataQuery] = None, *, cursor: Optional[str] = None, page_size: Optional[int] = None) -> FileDataPage:
        self._require_open()
        if query is not None and not isinstance(query, DataQuery):
            raise TypeError(f"expected DataQuery, got {type(query).__name__}")
        if query is not None and not isinstance(query, ObjectQuery):
            raise Unsupported(f"GcsSource does not support {type(query).__name__}")
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        token = _paging.query_token(query)
        params = {"fields": f"nextPageToken,items({OBJECT_FIELDS})", "maxResults": str(limit)}
        if cursor is not None:
            params["pageToken"] = _paging.decode(cursor, token)
        if query is not None and query.prefix:
            params["prefix"] = query.prefix
        body = (await self._request(self._bucket_path("/o"), params)).json()
        following = body.get("nextPageToken")
        return FileDataPage(
            # A zero-byte "directory placeholder" is not a document.
            items=tuple(self._item(meta) for meta in body.get("items") or () if meta.get("name") and not meta["name"].endswith("/")),
            next_cursor=_paging.encode(following, token) if following else None,
        )

    async def iterate(self, query: Optional[DataQuery] = None, *, page_size: Optional[int] = None) -> AsyncGenerator[FileItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(query, cursor=cursor, page_size=page_size)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    # ── bytes ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = DEFAULT_CHUNK_SIZE) -> AbstractAsyncContextManager[AsyncIterator[bytes]]:
        if not isinstance(file, FileItem):
            raise TypeError(f"expected FileItem, got {type(file).__name__}")
        return self._reader(file.origin, positive_int(chunk_size, "chunk_size", MAX_CHUNK_SIZE))

    @asynccontextmanager
    async def _reader(self, origin: CloudOrigin, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        self._require_open()
        assert self._http is not None
        url = f"{self._base}{self._object_path(self._scope.key(origin))}"
        try:
            async with self._http.stream("GET", url, params={"alt": "media"}, headers=self._auth()) as response:
                if response.status_code >= 400:
                    raise http.error_for_status(response.status_code, origin=origin)
                yield response.aiter_bytes(chunk_size)
        except httpx.HTTPError as exc:
            raise SourceUnavailable(f"GET {url}: {exc}", origin=origin) from exc

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        """Can this machine's Google credential read this bucket? Everything else is config."""
        if not _bucket_name(self.config):
            return Verdict(ready=False, detail="Set the bucket this source reads.")
        if self.credentials.token is None:
            return Verdict(ready=False, detail=_NO_CREDENTIAL)
        try:
            async with self:
                await self._request(self._bucket_path(), {"fields": "name"})
        except SourceError as exc:
            return Verdict(
                ready=False,
                detail=f"Google refused the stored credential for this bucket ({exc}). "
                f"Reconnect Google, granting {GCS_SCOPE}, and check the bucket name.",
            )
        return Verdict(ready=True)

    async def choices(self, field: str) -> list[dict]:
        """The buckets in ``config.project`` — read for THIS call only, so a source that names
        its bucket outright never needs one. Both refusals are answered before any request."""
        if field != "bucket":
            return []
        project = str(self.config.get("project") or "").strip()
        if not project:
            raise Rejected("Set 'GCP project' to list buckets, or type the bucket name.")
        if self.credentials.token is None:
            raise AccessDenied("No Google credential on this machine. Connect Google first.")
        body = (await self._request("/b", {"project": project, "fields": "items(name,location)"})).json()
        # A bucket's name IS its id.
        return [
            {"id": str(b["name"]), "name": str(b["name"]), "detail": str(b.get("location") or "").lower()}
            for b in body.get("items") or ()
            if b.get("name")
        ]

    # ── transport ───────────────────────────────────────────────────────────
    @property
    def _base(self) -> str:
        return str(self.config.get("base_url") or GCS_API_BASE).rstrip("/")

    def _bucket_path(self, suffix: str = "") -> str:
        # A bucket name is user input: a slash in it must never become a separator.
        return f"/b/{quote(self.bucket, safe='')}{suffix}"

    def _object_path(self, key: str) -> str:
        return self._bucket_path(f"/o/{quote(key, safe='')}")

    def _auth(self) -> dict[str, str]:
        if self.credentials.token is None:
            raise AccessDenied(_NO_CREDENTIAL)
        return {"Authorization": f"Bearer {self.credentials.token.get_secret_value()}"}

    async def _request(self, path: str, params: dict[str, str], **kwargs: Any) -> httpx.Response:
        self._require_open()
        assert self._http is not None
        return await http.request(self._http, "GET", f"{self._base}{path}", params=params, headers=self._auth(), **kwargs)

    def _item(self, meta: dict) -> FileItem:
        name = str(meta["name"])
        size = meta.get("size")
        data = GcsObjectData(
            name=name.rpartition("/")[2],
            path=name,
            size=int(size) if size not in (None, "") else None,
            media_type=meta.get("contentType") or None,
            generation=str(meta.get("generation") or "") or None,
            updated_at=iso_to_utc(meta["updated"]) if meta.get("updated") else None,
        )
        return FileItem(origin=self.origin(name), data=data)


def _bucket_name(config: dict) -> str:
    return str((config or {}).get("bucket") or "").strip().removeprefix("gs://").strip("/")


__all__ = ["GCS_API_BASE", "GCS_SCOPE", "ROOT_SEGMENT", "GcsObjectData", "GcsSource"]
