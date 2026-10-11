"""Where a ``flow show`` is presented is decided in the backend (``tab.show_placement``).

The calling process → its one Tab row (every presentation of a process folds onto
``shell|agentic_process-<id>``) → is that row a HOST (Vibe) tab? The answer is
stamped on the show so every client agrees; it used to be each frontend's guess
from the one app-wide view mode, which two sessions shown two ways cannot share.

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.tab import Tab, ensure_tab, process_tab, show_placement

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


def _pointer(view_type: str, process_id: str) -> str:
    """The stored pointer the frontend writes: the real viewType, the folded tabHash."""
    sub = f"agentic_process-{process_id}"
    return json.dumps({"viewType": view_type, "pointer": sub, "tabHash": f"shell|{sub}"})


async def _open(view_type: str, process_id: str) -> Tab:
    return await ensure_tab(_pointer(view_type, process_id), target_type="agentic_process", target_id=process_id)


@pytest.mark.asyncio
async def test_a_vibe_tab_is_a_host() -> None:
    pid = str(uuid.uuid4())
    tab = await _open("vibe", pid)

    assert await show_placement(pid) == {"tab_id": tab.id, "host": True}


@pytest.mark.asyncio
async def test_a_terminal_tab_is_not_a_host_and_shows_beside_it() -> None:
    pid = str(uuid.uuid4())
    tab = await _open("shell", pid)

    assert await show_placement(pid) == {"tab_id": tab.id, "host": False}


@pytest.mark.asyncio
async def test_the_answer_follows_the_tab_when_it_switches_surface() -> None:
    """One row per process: switching it to Vibe re-points the SAME row, and the
    next show sees the host."""
    pid = str(uuid.uuid4())
    shell = await _open("shell", pid)
    vibe = await _open("vibe", pid)

    assert vibe.id == shell.id
    assert (await process_tab(pid)).id == shell.id
    assert (await show_placement(pid))["host"] is True


@pytest.mark.asyncio
async def test_no_open_tab_means_no_anchor() -> None:
    """A background agent (no tab ever) and a closed tab both answer the same:
    nothing to pin into, nothing to sit beside."""
    never = str(uuid.uuid4())
    assert await show_placement(never) == {"tab_id": None, "host": False}

    closed = str(uuid.uuid4())
    tab = await _open("vibe", closed)
    await tab.close()
    assert await show_placement(closed) == {"tab_id": None, "host": False}
