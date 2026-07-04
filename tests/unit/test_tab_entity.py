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
async def test_delete_by_id_soft_closes_its_tabs() -> None:
    # Regression (proven this session — "Conversation not found" 404 on project
    # switch): the HTTP delete action (graph_crud_actions.handle_delete_by_id)
    # removes an entity via the CLASSMETHOD Entity.delete_by_id, NOT the instance
    # Entity.delete. Only the instance delete() carries the orphan-Tab cleanup, so
    # a delete through the real API path strands a visible Tab pointing at a now
    # nonexistent target. The projects switcher then resolves that tab and
    # navigates to a dead conversation URL that 404s.
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe-del-by-id#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    assert tab.visible is True

    # The exact method the HTTP delete action calls (graph_crud_actions.py:134).
    await _TabTargetProbe.delete_by_id(probe.id)

    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None and reloaded.visible is False, (
        "deleting the target via delete_by_id (the HTTP delete path) must soft-close "
        "its Tab, not leave a dangling chip that 404s on click"
    )


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


# ── parent_tab_id (generic tab grouping — the vibe child-tabs feature) ──────────


def _jptr(view_type: str, sub: str) -> str:
    """A realistic JSON DockPointer (what the frontend stores) — a bare string
    triggers the legacy-heal path on reopen and mutates the pointer, breaking a
    re-query by the original string. Real pointers are always JSON."""
    import json as _j

    return _j.dumps({"viewType": view_type, "pointer": f"{sub}#{uuid.uuid4()}"})


@pytest.mark.asyncio
async def test_parent_tab_id_set_on_create() -> None:
    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    child = await ensure_tab(
        _jptr("editor", "markdown"),
        target_type="markdown",
        target_id="md-child",
        parent_tab_id=parent.id,
    )
    assert child.parent_tab_id == parent.id


@pytest.mark.asyncio
async def test_parent_tab_id_adopted_on_reopen_and_preserved_on_none() -> None:
    # A tab already open with no parent gets adopted when reopened from inside a
    # workspace; a later reopen with no hint (None) preserves the group.
    p = _jptr("editor", "markdown")
    first = await ensure_tab(p, target_type="markdown", target_id="md-a")
    assert first.parent_tab_id is None

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    adopted = await ensure_tab(p, parent_tab_id=parent.id)
    assert adopted.id == first.id
    assert adopted.parent_tab_id == parent.id

    # No hint → preserve (matches the name/icon hint convention).
    preserved = await ensure_tab(p)
    assert preserved.parent_tab_id == parent.id

    # A DIFFERENT parent re-parents (last-writer-wins; a tab is in one group).
    parent2 = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    reparented = await ensure_tab(p, parent_tab_id=parent2.id)
    assert reparented.parent_tab_id == parent2.id


@pytest.mark.asyncio
async def test_parent_tab_id_never_self() -> None:
    # Guard: a tab is never made its own parent (backend defense; the client
    # registers the display tab as parent and could re-materialize the display).
    p = _jptr("shell", f"agentic_process-{uuid.uuid4()}")
    tab = await ensure_tab(p)
    same = await ensure_tab(p, parent_tab_id=tab.id)
    assert same.id == tab.id
    assert same.parent_tab_id is None, "a tab must never be its own parent"


@pytest.mark.asyncio
async def test_parent_soft_close_leaves_children_intact() -> None:
    # Parent close is soft and never touches children — they stay ordinary
    # global tabs; the deterministic id regroups them when the parent reopens.
    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    child = await ensure_tab(
        _jptr("editor", "markdown"), target_type="markdown", target_id="md-keep", parent_tab_id=parent.id
    )

    await parent.close()

    reloaded = await Tab.get_one({"id": child.id})
    assert reloaded is not None
    assert reloaded.visible is True, "child stays visible when parent soft-closes"
    assert reloaded.parent_tab_id == parent.id, "soft-close preserves the group edge"


@pytest.mark.asyncio
async def test_parent_tab_id_in_wire_projection() -> None:
    # _serialize_row is the actual wire projection for every list action — the
    # field MUST be there or the whole FE feature is dark.
    from flow_sdk.builtin.tab import _serialize_row

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    child = await ensure_tab(
        _jptr("editor", "markdown"), target_type="markdown", target_id="md-w", parent_tab_id=parent.id
    )
    row = _serialize_row(child)
    assert "parent_tab_id" in row
    assert row["parent_tab_id"] == parent.id


@pytest.mark.asyncio
async def test_hard_reap_clears_child_parent_refs() -> None:
    # A hard delete of the parent must null its children's parent_tab_id (unlike
    # soft-close) so no permanently-dangling edges accumulate.
    from flow_sdk.builtin.tab import _clear_parent_refs

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    child = await ensure_tab(
        _jptr("editor", "markdown"), target_type="markdown", target_id="md-reap", parent_tab_id=parent.id
    )

    await _clear_parent_refs({parent.id})

    reloaded = await Tab.get_one({"id": child.id})
    assert reloaded is not None and reloaded.parent_tab_id is None


@pytest.mark.asyncio
async def test_known_session_is_recoverable_via_existing_worker_session_path() -> None:
    # ISSUE 1 ("we already had fromWorkerSessionId"): a process that can't be found
    # by id must still be recoverable through the existing worker-session resolver,
    # so the load/reap path should consult it BEFORE declaring "not found" — only a
    # genuinely session-less target falls through to the issue-2 reap below.
    from flow_sdk.builtin.agentic_process import AgenticProcess

    session_id = f"sess-{uuid.uuid4()}"
    live = AgenticProcess(
        id=str(uuid.uuid4()), worker_type="claude_code", session_id=session_id
    )
    await live.save()

    # A stale/foreign process id is NOT resolvable by getById — the exact 404 the
    # loader hits today (the agentic_process-4c29… "not found" RCA)...
    stale_id = str(uuid.uuid4())
    assert await AgenticProcess.get_one({"id": stale_id}) is None

    # ...but the SAME worker session resolves via the existing resolver. This is
    # the recovery the loader/reaper must call before treating the URL as dead.
    recovered = await AgenticProcess.get_by_session_id(session_id)
    assert recovered is not None and recovered.id == live.id, (
        "the existing worker-session resolver must recover the live process for a "
        "known session — the load path should call this before 404-falling-back"
    )


@pytest.mark.asyncio
async def test_orphan_agentic_process_tab_is_reaped_when_target_missing() -> None:
    # ISSUE 2 (proven this session — the agentic_process-4c29… "not found" RCA):
    # a Tab denormalized onto an agentic_process whose entity row does NOT exist
    # (a bare FS stub never synced to the DB, or a process removed out from under
    # the tab) is never reaped. The list path's only reaper,
    # ``_delete_tabs_for_missing_projects`` (inside ``_visible_tabs_sorted``),
    # removes tabs for missing PROJECTS — there is no missing-TARGET reaping — so
    # the chip lingers and clicking it 404s on ``getById`` ("not found"). When the
    # target session is not found, the dangling tab must be removed.
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.builtin.tab import _build_tab_list

    ghost_id = str(uuid.uuid4())  # an agentic_process id with NO DB row (and no session)
    assert await AgenticProcess.get_one({"id": ghost_id}) is None, "precondition: target absent"

    tab = await ensure_tab(
        f"shell/agentic_process-{ghost_id}",
        target_type=AgenticProcess.get_type(),
        target_id=ghost_id,
        project_id=None,  # projectless: the missing-PROJECT reaper must NOT mask this
    )
    assert tab.visible is True

    listed = await _build_tab_list(None)
    assert tab.id not in {t.id for t in listed}, (
        "a tab whose agentic_process target has no resolvable entity (and no "
        "recoverable session) must be reaped from the list, not rendered as a "
        "broken chip that 404s on click"
    )
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is None or reloaded.visible is False, (
        "the dangling tab row must be removed/hidden"
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
async def test_tab_project_id_follows_target_entity_project_change() -> None:
    # ROOT CAUSE (proven this session): tab.project_id is a write-once snapshot of
    # the target entity's project, taken at tab creation. When the target entity's
    # project_id later changes (e.g. a conversation is assigned to a project),
    # nothing reconciles the dependent Tab — so the tab keeps rendering its stale
    # project color ("stays blue"). This is the project-change sibling of the
    # orphan-close hook that already exists for Entity.delete
    # (test_deleting_target_soft_closes_its_tabs) but is MISSING for a project change.
    p1 = str(uuid.uuid4())
    probe = _TabTargetProbe(id=str(uuid.uuid4()), project_id=p1)
    await probe.save()
    tab = await ensure_tab(
        f"dock/proj-follow#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
        project_id=p1,
    )
    assert tab.project_id == p1

    # The target entity is reassigned to a different project (the user's action).
    p2 = str(uuid.uuid4())
    probe.project_id = p2
    await probe.save()

    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None
    assert reloaded.project_id == p2, (
        "tab.project_id must follow its target entity's project change "
        "(currently stale → tab keeps the old project color / stays blue)"
    )


@pytest.mark.asyncio
async def test_ensure_tab_reopen_clears_project_to_match_target() -> None:
    # ISSUE 2 (refresh/reopen cannot clear-to-null): ensure_tab's reopen path
    # refreshes the denormalized project_id only `if val is not None`, so it can
    # never CLEAR a stale project back to null when the target is now projectless.
    # A refresh that re-resolves project_id=None from the target therefore leaves
    # the tab pinned to the old project.
    p = f"dock/reopen-clear#{uuid.uuid4()}"
    p1 = str(uuid.uuid4())
    tab = await ensure_tab(p, target_type="markdown", target_id="md-x", project_id=p1)
    assert tab.project_id == p1

    # Reopen with the target's CURRENT (now projectless) project_id.
    reopened = await ensure_tab(p, target_type="markdown", target_id="md-x", project_id=None)
    assert reopened.project_id is None, (
        "reopen must re-derive project_id from the target, including clearing to null"
    )


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
