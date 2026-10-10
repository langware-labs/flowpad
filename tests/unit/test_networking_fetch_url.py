"""``flow_sdk.utils.networking.fetch_url`` reads the source on every call.

It used to carry an opt-in module-level cache (``_url_fetch_cache``) that kept
one full body per distinct URL forever and served stale content after the file
changed. The cache is gone; these tests lock in that nothing is retained across
fetches and that a rewritten file is read fresh.
"""
from __future__ import annotations

import gc
import tracemalloc

import pytest

from flow_sdk.utils import file_system, networking


@pytest.fixture
def root_folder(tmp_path, monkeypatch):
    # ``fetch_url`` chdirs into ``file_system.ROOT_FOLDER`` for the read; in a
    # checkout that resolves to ``<repo>/flowpad``, which does not exist.
    monkeypatch.setattr(file_system, "ROOT_FOLDER", str(tmp_path))
    return tmp_path


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_fetch_url_reads_the_current_file_contents(root_folder):
    path = root_folder / "doc.txt"
    path.write_text("v1")
    assert await networking.fetch_url(str(path)) == "v1"
    path.write_text("v2")
    assert await networking.fetch_url(str(path)) == "v2"
    path.write_text('{"v": 3}')
    assert await networking.fetch_json(str(path)) == {"v": 3}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_fetch_url_retains_nothing_across_distinct_sources(root_folder):
    n, body = 50, 10_000
    files = [root_folder / f"f{i}.txt" for i in range(n)]
    for f in files:
        f.write_text("x" * body)
    gc.collect()
    tracemalloc.start(1)
    try:
        before = tracemalloc.get_traced_memory()[0]
        for f in files:
            assert len(await networking.fetch_url(str(f))) == body
        gc.collect()
        after = tracemalloc.get_traced_memory()[0]
    finally:
        tracemalloc.stop()
    # One retained body per source would be n * body (500 KB); allow allocator noise only.
    assert after - before < body * 2, f"fetch_url retained {after - before} bytes over {n} fetches"
