"""The ``gcs`` source's case in the data source matrix: a bucket over a loopback JSON API, read with a
doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.ingest.sources import source_type
from flow_sdk.ingest.testing import local_http_server

from .test_gcs_source import SEEDED, TOKEN, _Bucket, _credentials


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(source_type("gcs"), "credentials_for", _credentials(TOKEN))
    with local_http_server(_Bucket(SEEDED)) as base:
        yield {"config": {"bucket": "acme-docs", "base_url": base, "cache_root": str(tmp_path / "cache")}, "fields": {"reflect": "copy"}}
