"""``S3Source`` -- the objects in an Amazon S3 bucket, or an S3-compatible store.

Like ``gcs``, S3 has no change log: a traversal is one authoritative enumeration (``ListObjectsV2``)
and the application diffs it. The origin is ``(s3, <bucket>, <key>)``; a key is the identity.

**Rows** (``RowFiles``): a dataset whose ``location`` is ``s3:<bucket>/<prefix>`` keeps one object per
row file under the prefix. A write or delete is conditional on the object's ETag -- ``If-Match``, or
``If-None-Match: *`` for a file that must not exist yet -- so S3 itself refuses a stale write (412)
and two writers can never both land.

Requests are signed with SigV4 (``sigv4.py``) from ``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY``
(and ``AWS_SESSION_TOKEN`` for temporary keys). ``base_url`` points at an S3-compatible endpoint and
switches to path-style addressing (``<endpoint>/<bucket>/<key>``).
"""
from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Annotated, Any, AsyncGenerator, AsyncIterator, ClassVar, Mapping, Optional
from urllib.parse import urlparse

import httpx
from pydantic import AwareDatetime, StringConstraints

from flow_sdk.sources import _paging, http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import AccessDenied, Conflict, NotFound, Rejected, SourceError, is_transient
from flow_sdk.sources.families import ObjectSource
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import FileData, FileItem
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, FileDataPage
from flow_sdk.sources.values.query import ObjectQuery
from flow_sdk.utils.serialization import iso_to_utc

from .sigv4 import EMPTY_SHA256, encoded_path, sign

DEFAULT_REGION = "us-east-1"
DEFAULT_CHUNK_SIZE = 1 << 20
MAX_CHUNK_SIZE = 64 << 20
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_NO_CREDENTIAL = "No AWS keys on this machine. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (flow credentials set), then verify."


class S3ObjectData(FileData):
    """An object as the listing reported it. ``etag`` moves exactly when the bytes do."""

    spec_kind: ClassVar[str] = "ingest.file.s3"

    etag: Optional[str] = None
    updated_at: Optional[AwareDatetime] = None


class S3Config(SourceConfig):
    """What an s3 source is configured with."""

    bucket: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    #: What the source lists, and where a dataset's rows live; empty for the whole bucket.
    prefix: str = ""
    region: str = ""
    cache_root: str = ""
    base_url: str = ""


class S3Source(ObjectSource):

    Config = S3Config
    provider = "s3"
    page_size = MAX_PAGE_SIZE
    identity_config_key = "bucket"
    stamps_identity = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._http: Optional[httpx.AsyncClient] = None

    @classmethod
    def namespace_for(cls, binding: SourceBinding) -> str:
        return _bucket_name(binding.config) or cls.provider

    @classmethod
    def row_files_target(cls, target: str) -> dict:
        """``s3:<bucket>/<prefix>`` → the bucket and the prefix rows live under."""
        bucket, _, prefix = str(target).strip().removeprefix("s3://").strip("/").partition("/")
        if not bucket:
            raise ValueError("location: s3:<bucket>/<prefix> names a bucket")
        return {"bucket": bucket, "prefix": prefix.strip("/")}

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
    def query(self) -> ObjectQuery:
        return ObjectQuery(prefix=str(self.config.get("prefix") or "").strip())

    async def get(self, origin: CloudOrigin) -> Optional[FileItem]:
        self._require_open()
        key = self._scope.key(origin)
        response = await self._call("HEAD", key, ok_statuses=(404,))
        if response.status_code == 404:
            return None
        return self._item(key, response.headers.get("ETag"), response.headers.get("Content-Length"), None)

    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> FileDataPage:
        self._require_open()
        query = self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        token = _paging.query_token(query)
        listed, following = await self._list_page(query.prefix, limit, _paging.decode(cursor, token) if cursor else None)
        return FileDataPage(
            items=tuple(self._item(o["key"], o["etag"], o["size"], o["modified"]) for o in listed if not o["key"].endswith("/")),
            next_cursor=_paging.encode(following, token) if following else None,
        )

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

    async def _list_page(self, prefix: str, limit: int, token: Optional[str]) -> tuple[list[dict], Optional[str]]:
        params = {"list-type": "2", "max-keys": str(limit)}
        if prefix:
            params["prefix"] = prefix
        if token:
            params["continuation-token"] = token
        root = ET.fromstring((await self._call("GET", "", params=params)).content)
        listed = [{
            "key": c.findtext(f"{_NS}Key") or "",
            "etag": c.findtext(f"{_NS}ETag"),
            "size": c.findtext(f"{_NS}Size"),
            "modified": c.findtext(f"{_NS}LastModified"),
        } for c in root.iter(f"{_NS}Contents")]
        truncated = (root.findtext(f"{_NS}IsTruncated") or "").lower() == "true"
        return listed, (root.findtext(f"{_NS}NextContinuationToken") if truncated else None)

    # ── bytes ───────────────────────────────────────────────────────────────
    def open(self, file: FileItem, *, chunk_size: int = DEFAULT_CHUNK_SIZE) -> AbstractAsyncContextManager[AsyncIterator[bytes]]:
        if not isinstance(file, FileItem):
            raise TypeError(f"expected FileItem, got {type(file).__name__}")
        return self._reader(file.origin, positive_int(chunk_size, "chunk_size", MAX_CHUNK_SIZE))

    @asynccontextmanager
    async def _reader(self, origin: CloudOrigin, chunk_size: int) -> AsyncGenerator[AsyncIterator[bytes], None]:
        response = await self._call("GET", self._scope.key(origin), origin=origin)
        yield response.aiter_bytes(chunk_size)

    # ── rows (``RowFiles``) ─────────────────────────────────────────────────
    def _row_key(self, path: str) -> str:
        prefix = str(self.config.get("prefix") or "").strip("/")
        return f"{prefix}/{path}" if prefix else path

    async def list_files(self) -> dict[str, str]:
        self._require_open()
        prefix = str(self.config.get("prefix") or "").strip("/")
        base = f"{prefix}/" if prefix else ""
        out, token = {}, None
        while True:
            listed, token = await self._list_page(base, 1000, token)
            for o in listed:
                if o["key"].startswith(base) and not o["key"].endswith("/"):
                    out[o["key"][len(base):]] = str(o["etag"] or "")
            if not token:
                return out

    async def read_file(self, path: str) -> bytes:
        self._require_open()
        response = await self._call("GET", self._row_key(path), ok_statuses=(404,))
        if response.status_code == 404:
            raise NotFound(f"s3://{self.bucket}/{self._row_key(path)} is not there")
        return response.content

    async def write_file(self, path: str, data: bytes, *, expected: Optional[str] = None) -> str:
        self._require_open()
        self._require_writable()
        headers = _condition(expected)
        response = await self._call("PUT", self._row_key(path), content=bytes(data), headers=headers, ok_statuses=(409, 412))
        if response.status_code in (409, 412):
            raise Conflict(f"s3://{self.bucket}/{self._row_key(path)} is not at {expected or 'nothing'} any more")
        return str(response.headers.get("ETag") or "")

    async def delete_file(self, path: str, *, expected: Optional[str] = None) -> None:
        self._require_open()
        self._require_writable()
        if expected == "":
            return
        response = await self._call("DELETE", self._row_key(path), headers=_condition(expected), ok_statuses=(404, 409, 412))
        if response.status_code in (409, 412):
            raise Conflict(f"s3://{self.bucket}/{self._row_key(path)} is not at {expected} any more")

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        if not _bucket_name(self.config):
            return Verdict(ready=False, detail="Set the bucket this source reads.")
        if not self._keys():
            return Verdict(ready=False, detail=_NO_CREDENTIAL)
        try:
            async with self:
                await self._list_page(str(self.config.get("prefix") or ""), 1, None)
        except SourceError as exc:
            if is_transient(exc):
                raise
            return Verdict(ready=False, detail=f"S3 refused these keys for s3://{self.bucket} ({exc}). Check the keys, the region and the bucket name.")
        return Verdict(ready=True)

    # ── transport ───────────────────────────────────────────────────────────
    def _keys(self) -> Optional[tuple[str, str, Optional[str]]]:
        values = self.credentials.values or {}
        access, secret = values.get("AWS_ACCESS_KEY_ID"), values.get("AWS_SECRET_ACCESS_KEY")
        if access is None or secret is None:
            return None
        token = values.get("AWS_SESSION_TOKEN")
        return access.get_secret_value(), secret.get_secret_value(), token.get_secret_value() if token else None

    @property
    def _region(self) -> str:
        return str(self.config.get("region") or "").strip() or DEFAULT_REGION

    def _url(self, key: str) -> tuple[str, str, str]:
        """``(url, host, encoded path)`` for an object (``key``) or the bucket (``""``)."""
        custom = str(self.config.get("base_url") or "").rstrip("/")
        if custom:
            parsed = urlparse(custom)
            path = encoded_path(*[s for s in parsed.path.split("/") if s], self.bucket, *key.split("/")) if key else \
                encoded_path(*[s for s in parsed.path.split("/") if s], self.bucket) + "/"
            return f"{parsed.scheme}://{parsed.netloc}{path}", parsed.netloc, path
        host = f"{self.bucket}.s3.{self._region}.amazonaws.com"
        path = encoded_path(*key.split("/")) if key else "/"
        return f"https://{host}{path}", host, path

    async def _call(self, method: str, key: str, *, params: Optional[dict] = None, content: bytes = b"",
                    headers: Optional[dict] = None, ok_statuses: tuple[int, ...] = (), origin: Optional[CloudOrigin] = None) -> httpx.Response:
        self._require_open()
        assert self._http is not None
        keys = self._keys()
        if keys is None:
            raise AccessDenied(_NO_CREDENTIAL)
        url, host, path = self._url(key)
        params, headers = dict(params or {}), dict(headers or {})
        payload = hashlib.sha256(content).hexdigest() if content else EMPTY_SHA256
        signed = sign(method, host, path, params, headers, payload, access_key=keys[0], secret_key=keys[1],
                      region=self._region, session_token=keys[2])
        return await http.request(self._http, method, url, params=params, content=content or None,
                                  headers={**headers, **signed}, ok_statuses=ok_statuses, origin=origin)

    def _item(self, key: str, etag: Optional[str], size: Optional[str], modified: Optional[str]) -> FileItem:
        data = S3ObjectData(
            name=key.rpartition("/")[2],
            path=key,
            size=int(size) if size not in (None, "") else None,
            etag=str(etag or "").strip('"') or None,
            updated_at=iso_to_utc(modified) if modified else None,
        )
        return FileItem(origin=self.origin(key), data=data)


def _condition(expected: Optional[str]) -> dict[str, str]:
    if expected is None:
        return {}
    return {"If-None-Match": "*"} if expected == "" else {"If-Match": expected}


def _bucket_name(config: dict) -> str:
    return str((config or {}).get("bucket") or "").strip().removeprefix("s3://").strip("/")


__all__ = ["S3Config", "S3ObjectData", "S3Source"]
