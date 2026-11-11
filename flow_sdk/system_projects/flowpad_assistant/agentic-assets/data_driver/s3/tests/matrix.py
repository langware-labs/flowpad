"""The ``s3`` source's case in the data source matrix: a bucket over a loopback S3 endpoint
(path-style), read with doubled access keys."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server

from .test_s3_source import KEYS, _Bucket


async def _keys(_row):
    return KEYS


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(DataDriver.loaded("s3"), "credentials_for", _keys)
    bucket = _Bucket(objects={"a.md": b"# a\n", "b/c.md": b"# c\n", "d.md": b"# d\n"})
    with local_http_server(bucket) as base:
        yield {"config": {"bucket": "acme-data", "base_url": base, "cache_root": str(tmp_path / "cache")}, "fields": {"reflect": "copy"}}
