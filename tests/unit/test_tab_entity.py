"""Unit tests for the Tab placement entity (docs/tab-management.md).

A Tab is a DB-only row keyed by a hash of the canonical DockPointer string.
These cover the CRUD + query surface the frontend strip relies on:

- deterministic identity (same pointer → same id; different → different)
- get-or-create upsert (reopen reuses one row, re-shows it)
- soft-close (``visible=false`` — the row survives, never delete-to-close)
- the ``visible=true`` query that backs the strip, over a mixture of kinds
- teardown dispatch by target_type (duck-typed; absent method = no-op)

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.builtin.tab import Tab, delete_tabs_for_missing_project, ensure_tab, tab_id_for

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


class _TabTargetProbe(Entity):
    """A plain target entity (no rename override) — proves Tab.rename reflects
    onto ANY entity through the generic ``Entity.rename``, and that tab teardown
    dispatches by target_type (no real Shell/PTY needed)."""

    type: str = APIField(default="tab_target_probe")
    torn_down: bool = APIField(default=False)
    auto_rename: bool = APIField(default=False)

    async def teardown_for_tab(self) -> None:
        self.torn_down = True
        await self.save()


def test_visible_false_survives_exclude_none_wire_rule() -> None:
    """Membership removal must ride a NON-NULL signal: ``visible=false`` survives
    the ``exclude_none`` wire encoding (a nulled field would be stripped and a
    close could never propagate cross-client)."""
    from fastapi.encoders import jsonable_encoder

    tab = Tab(id=str(uuid.uuid4()), pointer="dock/x", visible=False)
    payload = jsonable_encoder(tab.model_dump(mode="json"), exclude_none=True)
    assert payload["visible"] is False  # non-null False survives the encoder


def test_tab_id_is_deterministic_uuid5() -> None:
    a = tab_id_for("dock/assets")
    b = tab_id_for("dock/assets")
    c = tab_id_for("dock/shell")
    assert a == b, "same pointer must mint the same id"
    assert a != c, "different pointers must mint different ids"
    assert uuid.UUID(a).version == 5, "Tab id must be a deterministic v5"


@pytest.mark.asyncio
async def test_ensure_tab_creates_then_reuses() -> None:
    p = f"dock/assets#{uuid.uuid4()}"  # unique per run — DB persists across tests
    first = await ensure_tab(p, target_type="markdown", target_id="markdown-x")
    assert first.id == tab_id_for(p)
    assert first.visible is True

    again = await ensure_tab(p)
    assert again.id == first.id, "reopen must reuse the same row, not duplicate"

    # Query by ID to verify the tab was stored correctly (pointer may be converted to JSON)
    row = await Tab.get_one({"id": first.id})
    assert row is not None, "tab must exist"
    assert row.id == first.id


@pytest.mark.asyncio
async def test_ensure_tab_heals_foreign_id_duplicate() -> None:
    # Regression: identity is uuid5(pointer), but a row minted under the old
    # client-side scheme carries a random uuid4 id for the same pointer. An
    # id-only dedup misses it and mints a second visible row (two chips, one
    # pointer). ensure_tab must reconcile by the NATURAL KEY (pointer): reuse the
    # canonical id==tab_id_for row and soft-hide the foreign-id stray.
    p = f"shell/agentic_process-{uuid.uuid4()}"
    stray = Tab(id=str(uuid.uuid4()), pointer=p, visible=True)  # uuid4, not tab_id_for
    await stray.save()
    assert uuid.UUID(stray.id).version == 4

    tab = await ensure_tab(p, target_type="agentic_process", target_id="ap-x")
    assert tab.id == tab_id_for(p), "canonical row is keyed by uuid5(pointer)"

    visible = [t for t in await Tab.get_all({"pointer": p}) if t.visible]
    assert len(visible) == 1, "exactly one visible row remains for the pointer"
    assert visible[0].id == tab.id, "the survivor is the canonical row"

    healed_stray = await Tab.get_one({"id": stray.id})
    assert healed_stray is not None and healed_stray.visible is False, (
        "the foreign-id stray is soft-hidden, not left as a duplicate chip"
    )


@pytest.mark.asyncio
async def test_close_is_soft_and_reopen_reshows() -> None:
    p = f"dock/shell#{uuid.uuid4()}"
    tab = await ensure_tab(p, target_type="shell", target_id="shell-y")

    await tab.close()
    assert tab.visible is False

    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None, "soft-close keeps the row (never delete-to-close)"
    assert reloaded.visible is False

    # Reopening the same pointer flips it back to visible — same row.
    reopened = await ensure_tab(p)
    assert reopened.id == tab.id
    assert reopened.visible is True


@pytest.mark.asyncio
async def test_visible_query_over_mixed_kinds() -> None:
    tag = uuid.uuid4()
    opened = [
        await ensure_tab(f"dock/shell#{tag}", target_type="shell", target_id=f"shell-{tag}"),
        await ensure_tab(f"editor/markdown#{tag}", target_type="markdown", target_id=f"md-{tag}"),
        await ensure_tab(f"editor/skill#{tag}", target_type="skill", target_id=f"sk-{tag}"),
        await ensure_tab(f"dock/settings#{tag}"),  # target-less transient surface
    ]
    closed = await ensure_tab(f"dock/search#{tag}")
    await closed.close()

    visible = {t.id for t in await Tab.get_all({"visible": True})}
    for t in opened:
        assert t.id in visible, "every open tab of any kind appears in one query"
    assert closed.id not in visible, "a closed tab is excluded from the visible query"


@pytest.mark.asyncio
async def test_teardown_dispatch_is_duck_typed_noop_when_absent() -> None:
    # A target_type with no live entity / no teardown_for_tab must not raise.
    p = f"dock/diff#{uuid.uuid4()}"
    tab = await ensure_tab(p, target_type="markdown", target_id="does-not-exist")
    await tab.close()  # resolves nothing → no-op, no exception
    assert tab.visible is False


@pytest.mark.asyncio
async def test_close_dispatches_teardown_to_target() -> None:
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    await tab.close()
    reloaded = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded is not None and reloaded.torn_down is True


@pytest.mark.asyncio
async def test_deleting_target_soft_closes_its_tabs() -> None:
    # Orphan cleanup: deleting the target entity hides its Tab (no dangling chip).
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe-del#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    assert tab.visible is True
    await probe.delete()
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None and reloaded.visible is False


@pytest.mark.asyncio
async def test_missing_project_cleanup_deletes_tab_without_target_teardown() -> None:
    # A missing project means the Tab row itself is stale. Clean it with
    # Tab.delete(), not Tab.close(), so the backing target is not torn down.
    dangling_project_id = str(uuid.uuid4())
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/missing-project-probe#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
        project_id=dangling_project_id,
    )

    deleted = await delete_tabs_for_missing_project(dangling_project_id)

    assert deleted == 1
    assert await Tab.get_one({"id": tab.id}) is None
    reloaded_probe = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded_probe is not None and reloaded_probe.torn_down is False


@pytest.mark.asyncio
async def test_agentic_process_close_hides_its_terminal_tab() -> None:
    # Regression: clicking close on an agentic_process terminal tab leaves the
    # chip on screen. AgenticProcess.close() stops the worker and deletes the
    # linked shell, but does NOT delete the process row (it persists as
    # ``stopped``). The Tab is keyed to the AGENTIC_PROCESS (target_type/id), so
    # the generic Entity.delete → orphan-Tab cleanup never fires for it — and
    # nothing else hides it, so it stays visible=true and the chip lingers.
    from flow_sdk.builtin.agentic_process import AgenticProcess

    ap = AgenticProcess(id=str(uuid.uuid4()), worker_type="claude_code")
    await ap.save()
    tab = await ensure_tab(
        f"shell/agentic_process-{ap.id}",
        target_type=AgenticProcess.get_type(),
        target_id=ap.id,
    )
    assert tab.visible is True

    await ap.close()

    # The process row persists (close is a stop, not a delete) — so hiding the
    # Tab can't rely on delete-cleanup; close() must soft-close it directly.
    assert await AgenticProcess.get_one({"id": ap.id}) is not None
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None and reloaded.visible is False, (
        "closing the process must soft-close its terminal Tab"
    )


@pytest.mark.asyncio
async def test_list_all_spans_all_projects_unlike_scoped_list() -> None:
    # `list_all` is the GLOBAL projection (every visible tab, all projects) that the
    # footer chip + sessions view need; the project-scoped `list(pid)` is
    # `{that project} + projectless`, and `list(None)` is projectless-only.
    from flow_sdk.builtin.tab import _build_list, _http_list_all

    tag = uuid.uuid4()
    pa = f"proj-a-{tag}"
    pb = f"proj-b-{tag}"
    a = await ensure_tab(f"shell|a#{tag}", target_type="shell", target_id=f"sa-{tag}", project_id=pa)
    b = await ensure_tab(f"shell|b#{tag}", target_type="shell", target_id=f"sb-{tag}", project_id=pb)
    free = await ensure_tab(f"dock/settings#{tag}")  # projectless

    res = await _http_list_all(Tab)
    ids = {r["id"] for r in res.data["tabs"]}
    assert {a.id, b.id, free.id} <= ids, "list_all spans every project + projectless"

    # The scoped list of project A excludes project B's tab (proves list_all differs).
    scoped_a = {r["id"] for r in await _build_list(pa)}
    assert a.id in scoped_a and free.id in scoped_a and b.id not in scoped_a


@pytest.mark.asyncio
async def test_set_label_changes_tab_name_without_touching_target() -> None:
    # set_label is the PTY auto-title mirror: it updates ONLY Tab.name and must NOT
    # reflect onto the target or pin auto_rename (which rename does) — else future
    # auto-titles would stop.
    probe = _TabTargetProbe(id=str(uuid.uuid4()), name="orig", auto_rename=True)
    await probe.save()
    tab = await ensure_tab(
        f"dock/set-label#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    await tab.set_label("auto-titled")
    assert tab.name == "auto-titled", "Tab label updated"
    reloaded = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded is not None
    assert reloaded.name == "orig", "target entity name is NOT changed by set_label"
    assert reloaded.auto_rename is True, "set_label must not pin auto_rename off"


@pytest.mark.asyncio
async def test_rename_reflects_onto_target_generically() -> None:
    # Tab.rename → target.rename: a plain entity (no override) still mirrors the
    # new label onto its own ``name`` via the generic Entity.rename.
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe-rename#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    await tab.rename("my pinned name")
    assert tab.name == "my pinned name"  # Tab.name is the source of truth
    reloaded = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded is not None and reloaded.name == "my pinned name"
