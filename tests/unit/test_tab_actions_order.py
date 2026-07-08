"""End-to-end ordering behavior of the backend tab actions (real DB, no mocks).

Drives the actual action handlers (`_http_new_tab`/`_http_list`/`_http_order`/
`_http_close`) — the same functions the graph router dispatches — and asserts the
global order, the opener-insert, the per-project filtered view, and reorder/close.
Complements the pure `test_tab_order.py` parity matrix with the persistence layer.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.tab import (
    Tab,
    _build_list,
    _http_close,
    _http_list,
    _http_new_tab,
    _http_order,
    ensure_tab,
    tab_id_for,
)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
async def _clean_visible_tabs():
    """Session SQLite is shared across tests; start each with no visible tabs so
    exact-order assertions aren't polluted by other tests' rows."""
    for tab in await Tab.get_all({"visible": True}):
        tab.visible = False
        await tab.save()
    yield


async def _order(project: str | None = None) -> list[str]:
    return [r["id"] for r in await _build_list(project)]


async def test_ensure_tab_assigns_contiguous_global_order() -> None:
    a = await ensure_tab("p/a", project_id="p1")
    b = await ensure_tab("p/b", project_id="p1")
    c = await ensure_tab("p/c", project_id="p1")
    assert (a.tab_order, b.tab_order, c.tab_order) == (0, 1, 2)
    assert await _order("p1") == [a.id, b.id, c.id]


async def test_new_tab_opener_inserts_after_opener() -> None:
    a = await ensure_tab("o/a", project_id="p1")
    await ensure_tab("o/b", project_id="p1")
    await ensure_tab("o/c", project_id="p1")
    # A new tab opened from within `a` lands immediately after `a`.
    await _http_new_tab(Tab, pointer="o/x", project_id="p1", after_tab_id=a.id)
    xid = tab_id_for("o/x")
    order = await _order("p1")
    assert order.index(xid) == order.index(a.id) + 1


async def test_reopen_keeps_slot() -> None:
    a = await ensure_tab("r/a", project_id="p1")
    b = await ensure_tab("r/b", project_id="p1")
    c = await ensure_tab("r/c", project_id="p1")
    before = await _order("p1")
    await b.close()
    again = await ensure_tab("r/b", project_id="p1")  # reopen same pointer
    assert again.id == b.id
    assert await _order("p1") == before == [a.id, b.id, c.id]


async def test_order_action_reorders_globally() -> None:
    a = await ensure_tab("d/a", project_id="p1")
    b = await ensure_tab("d/b", project_id="p1")
    c = await ensure_tab("d/c", project_id="p1")
    # Move c to the very front (after=None, before=a).
    await _http_order(Tab, reorder_tab_id=c.id, after_tab_id=None, before_tab_id=a.id)
    assert await _order("p1") == [c.id, a.id, b.id]


async def test_list_scopes_each_tab_to_exactly_one_view() -> None:
    # Each tab belongs to EXACTLY one scope — a projectless ("global") tab appears
    # only in the None (no active project) view, never inside a project's strip.
    a = await ensure_tab("f/a", project_id="pA")
    s = await ensure_tab("f/s", project_id=None)  # projectless (settings-like)
    bproj = await ensure_tab("f/b", project_id="pB")
    pa = await _order("pA")
    pb = await _order("pB")
    none_view = await _order(None)
    assert a.id in pa and s.id not in pa and bproj.id not in pa  # projectless no longer bleeds in
    assert bproj.id in pb and s.id not in pb and a.id not in pb
    assert none_view == [s.id]  # only projectless in the Global (no active project) view


async def test_close_action_drops_from_list() -> None:
    a = await ensure_tab("c/a", project_id="p1")
    b = await ensure_tab("c/b", project_id="p1")
    await _http_close(b)
    assert await _order("p1") == [a.id]
