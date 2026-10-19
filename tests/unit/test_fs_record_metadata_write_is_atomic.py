"""A reader never sees a half-written metadata.json.

``Entity`` persists a record's index with ``asyncio.to_thread(record.save_metadata, …)``,
so the write runs on a worker thread while the event loop keeps reading records.
A truncate-then-write lets a read land between the two and parse an empty file:
CI's e2e data-source matrix 500'd ``DELETE /graph/data_source`` with
``Expecting value: line 1 column 1 (char 0)`` from ``FSRecord.load_record``
while a reply's projection was still writing its conversation.
"""
from __future__ import annotations

import json
import threading

import pytest

from flow_sdk.fs_store.fs_record import FSRecord

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

WRITES = 300


def test_concurrent_reads_never_parse_a_partial_metadata_file():
    record = FSRecord("conversation", "11111111-1111-4111-8111-111111111111", name="seed")
    meta_path = record.save()
    padding = "x" * 20000  # a write large enough to be observed mid-flight

    done = threading.Event()
    torn: list[str] = []

    def reader() -> None:
        while not done.is_set():
            try:
                json.loads(meta_path.read_text(encoding="utf-8"))
            except ValueError as exc:
                torn.append(str(exc))
                return

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for i in range(WRITES):
            record.save_metadata({"name": f"n{i}", "padding": padding})
    finally:
        done.set()
        thread.join()

    assert not torn, f"a reader parsed a partial metadata.json: {torn[0]}"
    assert FSRecord.load_record(meta_path).name == f"n{WRITES - 1}"
