"""The ``gdrive`` source's case in the data source matrix: a drive over a loopback API, read with a
doubled connector token."""
from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.testing import local_http_server

from .test_gdrive_source import SEEDED, TOKEN, _credentials, _Drive


@contextmanager
def case(monkeypatch, tmp_path):
    monkeypatch.setattr(DataDriver.loaded("gdrive"), "credentials_for", _credentials(TOKEN))
    with local_http_server(_Drive(SEEDED)) as base:
        yield {"config": {"base_url": base, "cache_root": str(tmp_path / "cache")}, "fields": {"reflect": "copy"}}
