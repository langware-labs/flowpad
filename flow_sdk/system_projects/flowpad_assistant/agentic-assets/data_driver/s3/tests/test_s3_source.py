"""The ``s3`` data source, against a real socket serving S3's own response shapes (path-style, as an
S3-compatible endpoint is addressed). Pins the signing against AWS's published example, the listing,
and the row store: conditional writes and deletes that S3 itself refuses when stale."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlparse
from xml.sax.saxutils import escape

import pytest
from pydantic import SecretStr

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.errors import AccessDenied
from flow_sdk.sources.testing import check_row_files

S3Source = asset_module("s3").S3Source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

KEYS = ResolvedSecrets(shape=AuthShape.ENV, values={"AWS_ACCESS_KEY_ID": SecretStr("AKID"), "AWS_SECRET_ACCESS_KEY": SecretStr("secret")})


class _Bucket:
    """One bucket: objects by key with ETags; ``If-Match`` / ``If-None-Match`` honoured as S3 does."""

    def __init__(self, name="acme-data", objects=None):
        self.name, self.objects, self.calls = name, dict(objects or {}), []

    @staticmethod
    def _etag(data: bytes) -> str:
        return f'"{hashlib.md5(data).hexdigest()}"'  # noqa: S324 -- S3's own ETag for a single PUT

    def __call__(self, path, headers):
        url = urlparse(path)
        method = headers.get("_method", "GET") if isinstance(headers, dict) else "GET"
        auth = headers.get("Authorization", "") if isinstance(headers, dict) else headers.get("Authorization", "")
        if not auth.startswith("AWS4-HMAC-SHA256 Credential=AKID/"):
            return 403, b"<Error><Code>AccessDenied</Code></Error>", {}
        bucket, _, key = unquote(url.path).lstrip("/").partition("/")
        self.calls.append((method, key))
        if bucket != self.name:
            return 404, b"<Error><Code>NoSuchBucket</Code></Error>", {}
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if not key and query.get("list-type") == "2":
            prefix = query.get("prefix", "")
            listed = sorted(k for k in self.objects if k.startswith(prefix))
            limit, start = int(query.get("max-keys", "1000")), int(query.get("continuation-token") or 0)
            page, more = listed[start:start + limit], start + limit < len(listed)
            body = "".join(f"<Contents><Key>{escape(k)}</Key><ETag>{escape(self._etag(self.objects[k]))}</ETag>"
                           f"<Size>{len(self.objects[k])}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>"
                           for k in page)
            more_xml = f"<IsTruncated>true</IsTruncated><NextContinuationToken>{start + limit}</NextContinuationToken>" if more \
                else "<IsTruncated>false</IsTruncated>"
            xml = f'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{body}{more_xml}</ListBucketResult>'
            return 200, xml.encode(), {"Content-Type": "application/xml"}
        held = self.objects.get(key)
        current = self._etag(held) if held is not None else None
        if method in ("PUT", "DELETE"):
            if headers.get("If-None-Match") == "*" and current is not None:
                return 412, b"<Error><Code>PreconditionFailed</Code></Error>", {}
            if (wanted := headers.get("If-Match")) is not None and wanted != current:
                return 412, b"<Error><Code>PreconditionFailed</Code></Error>", {}
            if method == "PUT":
                self.objects[key] = headers["_raw"]
                return 200, b"", {"ETag": self._etag(headers["_raw"])}
            self.objects.pop(key, None)
            return 204, b"", {}
        if held is None:
            return 404, b"<Error><Code>NoSuchKey</Code></Error>", {}
        return 200, held, {"ETag": current, "Content-Length": str(len(held))}


def _source(base, **config):
    return S3Source(SourceBinding(source_id="ds-s3", config={"bucket": "acme-data", "base_url": base, **config}, credentials=KEYS))


async def test_the_signature_is_aws_own_example():
    """AWS's published SigV4 example for S3 (GET Object with a Range), signed byte for byte."""
    sign = asset_module("s3").sign
    headers = sign("GET", "examplebucket.s3.amazonaws.com", "/test.txt", {}, {"Range": "bytes=0-9"},
                   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                   access_key="AKIAIOSFODNN7EXAMPLE", secret_key="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                   region="us-east-1", now=datetime(2013, 5, 24, tzinfo=timezone.utc))
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")


async def test_rows_under_a_prefix_keep_the_row_files_contract():
    bucket = _Bucket(objects={"elsewhere/x.json": b"{}"})
    with local_http_server(bucket) as base:
        async with _source(base, prefix="gtm/leads") as source:
            await check_row_files(source)
    assert bucket.objects == {"elsewhere/x.json": b"{}"}                          # nothing outside the prefix moved


async def test_listing_reads_the_bucket_in_pages():
    bucket = _Bucket(objects={f"docs/{n}.md": b"x" for n in range(5)} | {"docs/": b""})
    with local_http_server(bucket) as base:
        async with _source(base, prefix="docs/") as source:
            first = await source.fetch(page_size=2)
            items = [item async for item in source.iterate(page_size=2)]
    assert 0 < len(first.items) <= 2 and first.next_cursor                         # a page holds at most what was asked
    assert sorted(i.data.path for i in items) == [f"docs/{n}.md" for n in range(5)]  # the folder placeholder is no document
    assert items[0].data.etag and items[0].origin.key == "docs/0.md"


async def test_a_read_only_source_never_writes():
    with local_http_server(_Bucket()) as base:
        source = S3Source(SourceBinding(source_id="ds-s3", config={"bucket": "acme-data", "base_url": base}, credentials=KEYS, read_only=True))
        async with source:
            with pytest.raises(AccessDenied):
                await source.write_file("rows/a/row.json", b"{}")


async def test_no_keys_is_said_in_words():
    with local_http_server(_Bucket()) as base:
        source = S3Source(SourceBinding(source_id="ds-s3", config={"bucket": "acme-data", "base_url": base}, credentials=ResolvedSecrets()))
        verdict = await source.verify()
        assert not verdict.ready and "AWS_ACCESS_KEY_ID" in verdict.detail
        assert (await _source(base).verify()).ready


async def test_a_location_names_the_bucket_and_the_prefix():
    assert S3Source.row_files_target("acme-data/gtm/leads") == {"bucket": "acme-data", "prefix": "gtm/leads"}
    assert S3Source.row_files_target("s3://acme-data") == {"bucket": "acme-data", "prefix": ""}
    with pytest.raises(ValueError):
        S3Source.row_files_target("")
