"""A factory reset cancels the startup system-content index still in flight.

The startup pass resolves the system project's id when it starts. Left running
through ``desktop-db/clear`` it wrote its rows into the NEW database stamped with
the OLD project id, and the reset's own re-index skipped them as hash-fresh — so
every shipped editor opened onto a dead project and its tab was reaped on mint
("Tab could not be materialized"). The reset's cancel seam must own that task.
"""

import asyncio

import pytest

from flow_sdk.fs_store.indexer import auto_index
from flow_sdk.server import app as server_app


@pytest.mark.asyncio
async def test_reset_cancel_seam_owns_the_startup_system_content_index(monkeypatch):
    started = asyncio.Event()

    async def slow_index_system_content():
        started.set()
        await asyncio.Event().wait()  # a walk still in flight when the reset lands

    import flow_sdk.server.routes.bootstrap as bootstrap

    monkeypatch.setattr(bootstrap, "index_system_content", slow_index_system_content)
    monkeypatch.setattr(server_app, "_system_content_index_task", None)

    await server_app._start_system_content_index()
    task = server_app._system_content_index_task
    assert task is not None
    await started.wait()

    await auto_index.cancel_auto_indexes()

    assert task.cancelled()
