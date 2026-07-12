"""End-to-end ordering behavior of the backend tab actions (real DB, no mocks).

Drives the actual action handlers (`_http_new_tab`/`_http_list`/`_http_order`/
`_http_close`) — the same functions the graph router dispatches — and asserts the
global order, the opener-insert, the per-project filtered view, and reorder/close.
Complements the pure `test_tab_order.py` parity matrix with the persistence layer.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.tab import (
    _PENDING_TEARDOWNS,
    Tab,
    _build_list,
    _http_close,
    _http_list,
    _http_new_tab,
    _http_order,
    drain_pending_teardowns,
    ensure_tab,
    tab_id_for,
)
from flow_sdk.core.entity.entity_model import Entity

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
async def _clean_visible_tabs():
    """Session SQLite is shared across tests; start each with no visible tabs so
    exact-order assertions aren't polluted by other tests' rows. Drain any
    background teardowns spawned by ``_http_close`` so the loop closes clean."""
    for tab in await Tab.get_all({"visible": True}):
        tab.visible = False
        await tab.save()
    yield
    await drain_pending_teardowns()


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


# ── Background teardown (fast close) ─────────────────────────────────────────

# Per-probe gates keyed by entity id — asyncio.Event is loop-bound, so tests
# create them at run time instead of on the (import-time) class.
_GATES: dict[str, asyncio.Event] = {}


class _BlockingTeardownProbe(Entity):
    """Target whose teardown blocks until its gate opens — proves ``_http_close``
    responds before teardown and that ``ensure_tab`` waits out a pending one."""

    type: str = APIField(default="tab_blocking_teardown_probe")
    torn_down: bool = APIField(default=False)

    async def teardown_for_tab(self) -> None:
        await _GATES[self.id].wait()
        self.torn_down = True
        await self.save()


class _RaisingTeardownProbe(Entity):
    type: str = APIField(default="tab_raising_teardown_probe")

    async def teardown_for_tab(self) -> None:
        raise RuntimeError("teardown boom")


async def _blocking_probe_tab(pointer: str) -> tuple[_BlockingTeardownProbe, Tab, asyncio.Event]:
    probe = _BlockingTeardownProbe(id=str(uuid.uuid4()))
    await probe.save()
    gate = asyncio.Event()
    _GATES[probe.id] = gate
    tab = await ensure_tab(
        pointer, target_type=probe.get_type(), target_id=probe.id, project_id="p1"
    )
    return probe, tab, gate


async def test_http_close_returns_before_teardown() -> None:
    probe, tab, gate = await _blocking_probe_tab("bg/a")
    try:
        # Responds while the gate is still shut: tab hidden, teardown not yet run.
        await _http_close(tab)
        reloaded_tab = await Tab.get_one({"id": tab.id})
        assert reloaded_tab.visible is False
        assert (await _BlockingTeardownProbe.get_one({"id": probe.id})).torn_down is False
    finally:
        gate.set()
    await drain_pending_teardowns()
    assert (await _BlockingTeardownProbe.get_one({"id": probe.id})).torn_down is True


async def test_http_close_logs_teardown_failure(caplog: pytest.LogCaptureFixture) -> None:
    probe = _RaisingTeardownProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        "bg/fail", target_type=probe.get_type(), target_id=probe.id, project_id="p1"
    )
    with caplog.at_level(logging.WARNING, logger="flow_sdk.builtin.tab"):
        await _http_close(tab)  # must not raise despite the failing teardown
        await drain_pending_teardowns()
        await asyncio.sleep(0)  # let the done-callback run
    assert tab.id not in _PENDING_TEARDOWNS
    assert any("tab teardown failed" in rec.message for rec in caplog.records)


async def test_reopen_waits_for_pending_teardown() -> None:
    probe, tab, gate = await _blocking_probe_tab("bg/reopen")
    try:
        await _http_close(tab)
        reopen = asyncio.create_task(
            ensure_tab(
                "bg/reopen", target_type=probe.get_type(), target_id=probe.id, project_id="p1"
            )
        )
        await asyncio.sleep(0.05)
        assert not reopen.done(), "reopen must block behind the in-flight teardown"
    finally:
        gate.set()
    again = await reopen
    assert again.id == tab.id
    assert again.visible is True


async def test_display_row_reap_keeps_order_contiguous() -> None:
    # A legacy display row wedged mid-order is reaped by the list read; the
    # global order must stay gap-free so the next insert lands contiguously.
    from flow_sdk.builtin.tab import _build_tab_list

    a = await ensure_tab("g/a", project_id="p1")
    legacy = Tab(
        id=tab_id_for('{"viewType": "display", "pointer": "agentic_process-g"}'),
        pointer='{"viewType": "display", "pointer": "agentic_process-g"}',
        target_type="agentic_process",
        target_id="g",
        project_id="p1",
        visible=True,
        tab_order=1,
    )
    await legacy.save()
    c = await ensure_tab("g/c", project_id="p1")

    await _build_tab_list("p1")  # reaps the display row
    assert await _order("p1") == [a.id, c.id]
    d = await ensure_tab("g/d", project_id="p1")
    order = await _order("p1")
    assert order == [a.id, c.id, d.id] or order.index(d.id) == order.index(c.id) + 1
