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
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    tag = uuid.uuid4()
    # A shell tab must point at a live Shell row: the list/order reap now treats a
    # shell target with no DB row as a dead session (same rule as agentic_process)
    # and drops the chip. Back the terminal-kind tab with a real Shell so this
    # "mixed kinds" query tests membership, not orphan reaping.
    live_shell = Shell(id=str(uuid.uuid4()))
    await live_shell.save()
    opened = [
        await ensure_tab(f"dock/shell#{tag}", target_type="shell", target_id=live_shell.id),
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
        _jptr("assets", "editor/markdown/typeid/markdown-x"),
        target_type="markdown",
        target_id="md-child",
        parent_tab_id=parent.id,
    )
    assert child.parent_tab_id == parent.id


@pytest.mark.asyncio
async def test_raw_editor_pointer_is_adoptable_but_empty_editor_is_not() -> None:
    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))

    raw_file = await ensure_tab(
        _jptr("editor", "/tmp/project/main.py"),
        parent_tab_id=parent.id,
    )
    assert raw_file.parent_tab_id == parent.id

    import json as _j

    empty_editor = await ensure_tab(
        _j.dumps({"viewType": "editor", "pointer": ""}),
        parent_tab_id=parent.id,
    )
    assert empty_editor.parent_tab_id is None


@pytest.mark.asyncio
async def test_parent_tab_id_adopted_on_reopen_and_preserved_on_none() -> None:
    # A tab already open with no parent gets adopted when reopened from inside a
    # workspace; a later reopen with no hint (None) preserves the group.
    p = _jptr("assets", "editor/markdown/typeid/markdown-x")
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
async def test_parent_dropped_for_non_content_pointer() -> None:
    # Only a content-asset dock (assets ``editor/...`` pointer) may be a child.
    # A navigation surface — here an assets LIST / project-home pointer, whose
    # target_type is null so the target-type belt can't catch it — never adopts,
    # whatever hint the client sent (create path)…
    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    lst = await ensure_tab(_jptr("assets", "project-home"), parent_tab_id=parent.id)
    assert lst.parent_tab_id is None

    # …and a legacy row that already carries the stale edge (written under the
    # retired display-tab model) is null-healed on touch (reopen path) — the
    # edge otherwise resurrects the vibe workspace around a top-level surface
    # (RCA 2026-07-16: rail project button reopened the last process).
    p = _jptr("assets", "project-home")
    row = await ensure_tab(p)
    row.parent_tab_id = parent.id
    await row.save()
    healed = await ensure_tab(p)
    assert healed.id == row.id
    assert healed.parent_tab_id is None


@pytest.mark.asyncio
async def test_list_read_sweeps_stale_parent_off_non_adoptable_row() -> None:
    # The reap pass is the authoritative bulk heal: a non-adoptable row carrying
    # a stale parent edge (whose parent row still EXISTS, so the dangling-edge
    # sweep never matches it) heals on any list read, without being opened.
    from flow_sdk.builtin.tab import _build_tab_list

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    row = await ensure_tab(_jptr("assets", "project-home"))
    row.parent_tab_id = parent.id
    await row.save()

    await _build_tab_list(None)

    reloaded = await Tab.get_one({"id": row.id})
    assert reloaded is not None and reloaded.parent_tab_id is None, (
        "list read must null-heal a stale parent edge on a non-adoptable row"
    )
    # An adoptable child under a live parent is untouched by the sweep.
    child = await ensure_tab(
        _jptr("assets", "editor/markdown/typeid/markdown-x"),
        target_type="markdown",
        target_id="md-sweep",
        parent_tab_id=parent.id,
    )
    await _build_tab_list(None)
    kept = await Tab.get_one({"id": child.id})
    assert kept is not None and kept.parent_tab_id == parent.id


@pytest.mark.asyncio
async def test_plain_shell_adopts_but_process_anchor_never_does() -> None:
    # A terminal opened INSIDE a vibe workspace is content in its display, so a
    # plain shell dock is an adoptable child. The process's own dock shares the
    # `shell` viewType and is told apart only by its pointer — it is the
    # workspace ANCHOR, and adopting it nests a workspace inside itself.
    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))

    terminal = await ensure_tab(
        _jptr("shell", f"shell-{uuid.uuid4()}"),
        target_type="shell",
        target_id="sh-child",
        parent_tab_id=parent.id,
    )
    assert terminal.parent_tab_id == parent.id, "a plain terminal is workspace content"

    anchor_ptr = _jptr("shell", f"agentic_process-{uuid.uuid4()}")
    anchor = await ensure_tab(
        anchor_ptr,
        target_type="agentic_process",
        target_id=str(uuid.uuid4()),
        parent_tab_id=parent.id,
    )
    assert anchor.parent_tab_id is None, "a process anchor is never a child (create)"

    # …and the hint stays dropped when the same row is reopened.
    reopened = await ensure_tab(anchor_ptr, parent_tab_id=parent.id)
    assert reopened.id == anchor.id
    assert reopened.parent_tab_id is None, "a process anchor is never a child (reopen)"


@pytest.mark.asyncio
async def test_list_read_keeps_a_plain_shell_child_but_sweeps_a_process_child() -> None:
    # The bulk sweep runs on EVERY list read: if it disagreed with the adopt
    # gate, a terminal's parent edge would be written and then stripped seconds
    # later, leaving the workspace half-working.
    from flow_sdk.builtin.shell import Shell
    from flow_sdk.builtin.tab import _build_tab_list

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    # A REAL Shell row: a shell-targeted tab whose entity is gone is hard-deleted
    # by the missing-target sweep, which would mask what this test asserts.
    shell = Shell(name=f"sweep-{uuid.uuid4().hex[:8]}")
    await shell.save()
    terminal = await ensure_tab(
        _jptr("shell", f"shell-{shell.id}"),
        target_type="shell",
        target_id=str(shell.id),
        parent_tab_id=parent.id,
    )
    # A process-pointer row force-fed a parent edge must still heal.
    anchor = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    anchor.parent_tab_id = parent.id
    await anchor.save()

    await _build_tab_list(None)

    kept = await Tab.get_one({"id": terminal.id})
    assert kept is not None and kept.parent_tab_id == parent.id, (
        "the sweep must not strip a plain terminal's workspace edge"
    )
    healed = await Tab.get_one({"id": anchor.id})
    assert healed is not None and healed.parent_tab_id is None, (
        "the sweep must still null-heal a process anchor carrying a parent edge"
    )


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
        _jptr("assets", "editor/markdown/typeid/markdown-x"), target_type="markdown", target_id="md-keep", parent_tab_id=parent.id
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
        _jptr("assets", "editor/markdown/typeid/markdown-x"), target_type="markdown", target_id="md-w", parent_tab_id=parent.id
    )
    row = _serialize_row(child)
    assert "parent_tab_id" in row
    assert row["parent_tab_id"] == parent.id


@pytest.mark.asyncio
async def test_hard_reap_clears_child_parent_refs() -> None:
    # A hard delete of the parent must null its children's parent_tab_id (unlike
    # soft-close) so no permanently-dangling edges accumulate.
    from flow_sdk.builtin.tab import _reparent_children

    parent = await ensure_tab(_jptr("shell", f"agentic_process-{uuid.uuid4()}"))
    child = await ensure_tab(
        _jptr("assets", "editor/markdown/typeid/markdown-x"), target_type="markdown", target_id="md-reap", parent_tab_id=parent.id
    )

    await _reparent_children({parent.id: None})

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
async def test_orphan_shell_tab_is_reaped_when_target_missing() -> None:
    # Sibling of the agentic_process reap above, proven via the interactive-tabs
    # matrix "External REST DELETE/close removes a session" RCA: a shell is ALWAYS
    # DB-backed, so a shell tab whose Shell row is gone (the session was closed)
    # is a dead chip — not a valid unindexed-on-disk target. The generic
    # orphan-close soft-hides it on delete, but a reload whose active URL points at
    # that now-deleted shell re-mints the row through ensure_tab (visible again);
    # the list-path reap must drop it exactly like an agentic_process orphan, or
    # the closed session's chip resurrects and never leaves the strip.
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415
    from flow_sdk.builtin.tab import _build_tab_list

    ghost_id = str(uuid.uuid4())  # a shell id with NO DB row
    assert await Shell.get_one({"id": ghost_id}) is None, "precondition: target absent"

    tab = await ensure_tab(
        f"shell/shell-{ghost_id}",
        target_type="shell",
        target_id=ghost_id,
        project_id=None,  # projectless: the missing-PROJECT reaper must NOT mask this
    )
    assert tab.visible is True

    listed = await _build_tab_list(None)
    assert tab.id not in {t.id for t in listed}, (
        "a tab whose shell target has no resolvable entity must be reaped from the "
        "list, not rendered as a chip for a closed session"
    )
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is None or reloaded.visible is False, (
        "the dangling shell tab row must be removed/hidden"
    )


@pytest.mark.asyncio
async def test_activate_is_noop_on_a_soft_closed_tab() -> None:
    # Recency (`last_active_at`) is the close-resolver's tier-3 seed. `activate` is
    # fired fire-and-forget on select; a click immediately followed by a close can
    # let that stamp land AFTER the close (late under load), re-seeding the dead tab
    # as most-recent and dragging the self-heal back onto it. A soft-closed tab is
    # never a resolver candidate and activate never re-shows membership (reopen goes
    # through ensure_tab), so activate on a `visible=False` tab must be a strict
    # no-op: recency unchanged, still hidden.
    from flow_sdk.core.entity.entity_model import _http_activate

    tab = await ensure_tab(
        f"dock/activate-noop#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=str(uuid.uuid4()),
    )
    stale_visible = await Tab.get_one({"id": tab.id})
    assert stale_visible is not None and stale_visible.visible is True
    await tab.close()
    assert tab.visible is False
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None
    before = reloaded.last_active_at

    response = await _http_activate(stale_visible)

    after = await Tab.get_one({"id": tab.id})
    assert after is not None
    assert after.last_active_at == before, "activate must NOT stamp recency on a closed tab"
    assert after.visible is False, "activate must NOT re-show a soft-closed tab"
    assert response.data["last_active_at"] == before


@pytest.mark.asyncio
async def test_activate_stale_snapshot_cannot_clobber_newer_unrelated_field() -> None:
    """The fire-and-forget recency write must not full-save its stale snapshot."""
    from flow_sdk.core.entity.entity_model import _http_activate

    probe = _TabTargetProbe(id=str(uuid.uuid4()), torn_down=False)
    await probe.save()
    stale = await _TabTargetProbe.get_one({"id": probe.id})
    newer = await _TabTargetProbe.get_one({"id": probe.id})
    assert stale is not None and newer is not None

    newer.torn_down = True
    await newer.save()
    assert stale.torn_down is False, "precondition: activate receives a stale snapshot"

    notifications = []
    stale.observe(notifications.append)
    response = await _http_activate(stale)

    persisted = await _TabTargetProbe.get_one({"id": probe.id})
    assert persisted is not None
    assert persisted.torn_down is True, (
        "activate may update recency only; it must preserve a newer unrelated field"
    )
    assert persisted.last_active_at == response.data["last_active_at"]
    assert stale.last_active_at == persisted.last_active_at
    assert len(notifications) == 1, "activate must retain its UPDATE notification"
    assert notifications[0].data.torn_down is True, (
        "the notification must carry the fresh persisted row, not the stale snapshot"
    )


@pytest.mark.asyncio
async def test_activate_deleted_snapshot_fails_without_phantom_notification() -> None:
    """A delete race cannot report or broadcast a recency update that did not persist."""
    from flow_sdk.core.entity.entity_model import _http_activate

    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    stale = await _TabTargetProbe.get_one({"id": probe.id})
    assert stale is not None
    notifications = []
    stale.observe(notifications.append)
    await probe.delete()

    response = await _http_activate(stale)

    assert response.status == "FAIL"
    assert response.status_code == 404
    assert notifications == []
    assert await _TabTargetProbe.get_one({"id": probe.id}) is None


@pytest.mark.asyncio
async def test_list_all_spans_all_projects_unlike_scoped_list() -> None:
    # `list_all` is the GLOBAL projection (every visible tab, all projects) that the
    # footer chip + sessions view need; the project-scoped `list(pid)` is that
    # project's tabs ONLY (each tab belongs to exactly one scope), and `list(None)`
    # is the Global/projectless view.
    from flow_sdk.builtin.tab import _build_list, _http_list_all

    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    tag = uuid.uuid4()
    pa = f"proj-a-{tag}"
    pb = f"proj-b-{tag}"
    # Live Shell rows so the target reap keeps these terminal tabs (a shell tab
    # whose Shell is absent is now reaped as a dead session, same as agentic_process).
    sa = Shell(id=str(uuid.uuid4()))
    sb = Shell(id=str(uuid.uuid4()))
    await sa.save()
    await sb.save()
    a = await ensure_tab(f"shell|a#{tag}", target_type="shell", target_id=sa.id, project_id=pa)
    b = await ensure_tab(f"shell|b#{tag}", target_type="shell", target_id=sb.id, project_id=pb)
    free = await ensure_tab(f"dock/settings#{tag}")  # projectless

    res = await _http_list_all(Tab)
    ids = {r["id"] for r in res.data["tabs"]}
    assert {a.id, b.id, free.id} <= ids, "list_all spans every project + projectless"

    # The scoped list of project A is project A's tabs ONLY — it excludes project
    # B's tab AND the projectless/global tab (which lives only in the None view).
    scoped_a = {r["id"] for r in await _build_list(pa)}
    assert a.id in scoped_a and free.id not in scoped_a and b.id not in scoped_a
    # The Global (None) view is the projectless tab only.
    scoped_none = {r["id"] for r in await _build_list(None)}
    assert free.id in scoped_none and a.id not in scoped_none and b.id not in scoped_none


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


@pytest.mark.asyncio
async def test_agentic_process_rename_reflects_without_tab_fs_shadow() -> None:
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.flowpad_types.enums import WorkerType
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    process = AgenticProcess(
        name="original",
        auto_rename=True,
        worker_type=WorkerType.CLAUDE_CODE,
    )
    await process.save()
    tab = await ensure_tab(
        f"shell/agentic_process-{process.id}",
        target_type=AgenticProcess.get_type(),
        target_id=process.id,
    )

    await tab.rename("my pinned process")

    reloaded_tab = await Tab.get_one({"id": tab.id})
    reloaded_process = await AgenticProcess.get_one({"id": process.id})
    assert reloaded_tab is not None and reloaded_tab.name == "my pinned process"
    assert reloaded_process is not None and reloaded_process.name == "my pinned process"
    assert reloaded_process.auto_rename is False
    assert not shadow_dir_for(Tab.get_type(), tab.id).exists()


# ── Scope-keyed identity (assets/explorer): tabHash drives the uuid5 ─────────
#
# A scope-keyed dock normalizes its sub-pointer to '' and carries its identity
# in the frontend-computed ``tabHash`` field ("explorer|project:<id>"). The id
# derivation must honor it — otherwise EVERY scope of the view hashes to the
# same uuid5 ("tab:explorer|") and each scope switch steals the single row
# (the "one Tab row per scope" contract in DockPointer.toJSON breaks).

import json as _test_json


def _scoped_pointer(view: str, project_id: str) -> str:
    """The exact JSON shape DockPointer.toJSON emits for a project-scoped dock."""
    return _test_json.dumps(
        {
            "viewType": view,
            "pointer": "",
            "options": {"scope-mode": "project", "scope-activeProjectId": project_id},
            "tabHash": f"{view}|project:{project_id}",
        },
        separators=(",", ":"),
    )


def _scoped_asset_content_pointer(project_id: str) -> str:
    """Scope-keyed asset content keeps its identity plus the adoption bit."""
    return _test_json.dumps(
        {
            "viewType": "assets",
            "pointer": "",
            "options": {
                "scope-mode": "project",
                "scope-activeProjectId": project_id,
            },
            "tabHash": f"assets|project:{project_id}",
            "workspaceContent": True,
        },
        separators=(",", ":"),
    )


def test_tab_id_prefers_tab_hash_and_stays_stable_without_it() -> None:
    pa, pb = str(uuid.uuid4()), str(uuid.uuid4())
    a = tab_id_for(_scoped_pointer("explorer", pa))
    b = tab_id_for(_scoped_pointer("explorer", pb))
    assert a != b, "different scopes must mint different Tab ids"
    assert a == tab_id_for(f"explorer|project:{pa}"), "id is uuid5 over the tabHash"

    # Stability regression: a pointer WITHOUT tabHash (shells, conversations,
    # projects…) must hash byte-identically to the pre-change derivation.
    plain = _test_json.dumps({"viewType": "shell", "pointer": "agentic_process-x"})
    assert tab_id_for(plain) == tab_id_for("shell|agentic_process-x")


@pytest.mark.asyncio
async def test_scope_keyed_asset_content_keeps_parent_until_browser_root() -> None:
    from flow_sdk.builtin.project import Project

    project_id = str(uuid.uuid4())
    await Project(id=project_id, name=f"tab-content-{project_id[:8]}").save()
    parent = await ensure_tab(
        _jptr("shell", f"shell-{uuid.uuid4()}"),
        project_id=project_id,
    )
    content_pointer = _scoped_asset_content_pointer(project_id)
    root_pointer = _scoped_pointer("assets", project_id)

    child = await ensure_tab(
        content_pointer,
        target_type="markdown",
        target_id=str(uuid.uuid4()),
        project_id=project_id,
        parent_tab_id=parent.id,
    )
    assert child.parent_tab_id == parent.id

    # The wire list/reap pass must retain the URL-proven content edge.
    from flow_sdk.builtin.tab import _build_tab_list

    listed = await _build_tab_list(project_id)
    listed_child = next(tab for tab in listed if tab.id == child.id)
    assert listed_child.parent_tab_id == parent.id

    # Navigating the same scope-keyed tab to its browser root keeps the uuid5
    # identity but clears the no-longer-valid workspace edge.
    root = await ensure_tab(root_pointer, project_id=project_id)
    assert root.id == child.id
    assert root.parent_tab_id is None


@pytest.mark.asyncio
async def test_ensure_tab_scoped_rows_coexist_per_project() -> None:
    pa, pb = str(uuid.uuid4()), str(uuid.uuid4())
    a = await ensure_tab(_scoped_pointer("explorer", pa), project_id=pa)
    b = await ensure_tab(_scoped_pointer("explorer", pb), project_id=pb)
    assert a.id != b.id, "each scope owns its own row"
    assert a.visible and b.visible, "opening scope B must not hide/steal scope A's row"
    assert (a.project_id, b.project_id) == (pa, pb)

    again = await ensure_tab(_scoped_pointer("explorer", pa), project_id=pa)
    assert again.id == a.id, "reopen of a scope reuses its row"


@pytest.mark.asyncio
async def test_ensure_tab_heals_legacy_scope_shared_row() -> None:
    # A row minted under the old derivation carries id=uuid5("tab:<view>|") even
    # though its stored pointer already includes the scoped tabHash (the frontend
    # always persisted it). On next open the same pointer string is re-emitted,
    # so the same-pointer stray-heal must hide the legacy-id row and mint the
    # canonical scope-keyed one.
    pa = str(uuid.uuid4())
    pointer = _scoped_pointer("assets", pa)
    legacy = Tab(id=tab_id_for('{"viewType":"assets","pointer":""}'), pointer=pointer, visible=True)
    await legacy.save()

    tab = await ensure_tab(pointer, project_id=pa)
    assert tab.id == tab_id_for(pointer) != legacy.id

    visible = [t for t in await Tab.get_all({"pointer": pointer}) if t.visible]
    assert [t.id for t in visible] == [tab.id], "one visible row: the scope-keyed one"
    hidden = await Tab.get_one({"id": legacy.id})
    assert hidden is not None and hidden.visible is False


# ── Synthetic-name backstop: never freeze the FE `<type>-<id>` synthetic ────────


def test_is_synthetic_name_matches_only_the_synthetic_shape() -> None:
    from flow_sdk.builtin.tab import _is_synthetic_name

    tid = "94dbca09-85e6-42c5-b8a7-c2153d26a11d"
    # The two exact synthetic forms defaultDisplayName produces.
    assert _is_synthetic_name(f"agentic_process-{tid}", "agentic_process", tid) is True
    assert _is_synthetic_name("agentic_process-94db…a11d", "agentic_process", tid) is True
    # A real user name — even one that starts with the type token — is NOT synthetic.
    assert _is_synthetic_name("agentic_process notes", "agentic_process", tid) is False
    assert _is_synthetic_name("My run", "agentic_process", tid) is False
    # Wrong target / prefix / empty.
    assert _is_synthetic_name(f"shell-{tid}", "agentic_process", tid) is False
    assert _is_synthetic_name("", "agentic_process", tid) is False
    assert _is_synthetic_name(None, "agentic_process", tid) is False


@pytest.mark.asyncio
async def test_ensure_tab_does_not_persist_synthetic_name() -> None:
    # A stale/legacy client may send the `<type>-<id>` synthetic as the name.
    # ensure_tab must drop it so the durable Tab.name stays empty (heals later
    # once a real name is stamped), never freezing the synthetic.
    target = str(uuid.uuid4())
    p = f"shell/agentic_process-{target}"
    tab = await ensure_tab(
        p,
        target_type="agentic_process",
        target_id=target,
        name=f"agentic_process-{target}",
    )
    assert not tab.name, "synthetic name must not be adopted as the durable label"

    # A real name on the same pointer IS adopted (backfill of the null name).
    again = await ensure_tab(p, target_type="agentic_process", target_id=target, name="Real title")
    assert again.id == tab.id
    assert again.name == "Real title"


# ── One-tab-per-process: parent invariant + legacy display-row reap ──────────
#
# The display surface is no longer a Tab identity (a process has exactly ONE
# tab — its shell pointer; vibe is a rendering mode). Two backend guarantees:
# 1. A process/project tab is never a workspace CHILD: ``ensure_tab`` drops the
#    ``parent_tab_id`` hint on mint, and null-heals a legacy corrupt row on touch.
# 2. Legacy display-pointer rows are reaped from the list path regardless of
#    target liveness, re-anchoring their children to the same target's shell tab.


@pytest.mark.asyncio
async def test_ensure_tab_never_parents_process_or_project_tabs() -> None:
    anchor = await ensure_tab(f"shell/agentic_process-{uuid.uuid4()}")
    ap_id = str(uuid.uuid4())
    proc_tab = await ensure_tab(
        f"shell/agentic_process-{ap_id}",
        target_type="agentic_process",
        target_id=ap_id,
        parent_tab_id=anchor.id,
    )
    assert proc_tab.parent_tab_id is None, "a process tab must never be minted as a child"

    proj_id = str(uuid.uuid4())
    proj_tab = await ensure_tab(
        f'{{"viewType": "project", "pointer": "{proj_id}"}}',
        target_type="project",
        target_id=proj_id,
        parent_tab_id=anchor.id,
    )
    assert proj_tab.parent_tab_id is None, "a project tab must never be minted as a child"

    # Content tabs still adopt (the invariant is scoped, not a blanket ban).
    child = await ensure_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-inv"}',
        target_type="markdown",
        target_id="md-inv",
        parent_tab_id=anchor.id,
    )
    assert child.parent_tab_id == anchor.id


@pytest.mark.asyncio
async def test_ensure_tab_null_heals_legacy_parented_process_tab() -> None:
    # A pre-invariant DB may hold a process tab already carrying a parent
    # (the shell-under-display corruption). Reopening it must heal the edge.
    anchor = await ensure_tab(f"shell/agentic_process-{uuid.uuid4()}")
    ap_id = str(uuid.uuid4())
    pointer = f"shell/agentic_process-{ap_id}"
    corrupt = await ensure_tab(pointer, target_type="agentic_process", target_id=ap_id)
    corrupt.parent_tab_id = anchor.id  # simulate the legacy write path
    await corrupt.save()

    healed = await ensure_tab(pointer, target_type="agentic_process", target_id=ap_id)
    assert healed.id == corrupt.id
    assert healed.parent_tab_id is None, "reopen must null-heal the corrupt parent edge"


async def _live_process():
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(name=f"one-tab-{uuid.uuid4().hex[:8]}")
    await proc.save()
    return proc


async def _seed_tab(pointer: str, **fields) -> Tab:
    """Seed a row DIRECTLY (no ensure_tab) — models pre-upgrade legacy state.
    ``ensure_tab``'s fresh-create path runs the list reaper for its ordering
    read, which would reap a just-seeded display row mid-setup and invalidate
    the scenario being staged."""
    tab = Tab(id=tab_id_for(pointer), pointer=pointer, visible=True, **fields)
    await tab.save()
    return tab


@pytest.mark.asyncio
async def test_display_row_reaped_and_children_reanchored_to_shell_tab() -> None:
    from flow_sdk.builtin.tab import _build_tab_list

    proc = await _live_process()
    apid = str(proc.id)
    shell_tab = await _seed_tab(
        f'{{"viewType": "shell", "pointer": "agentic_process-{apid}"}}',
        target_type="agentic_process",
        target_id=apid,
    )
    display_tab = await _seed_tab(
        f'{{"viewType": "display", "pointer": "agentic_process-{apid}"}}',
        target_type="agentic_process",
        target_id=apid,
    )
    child = await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-reanchor"}',
        target_type="markdown",
        target_id="md-reanchor",
        parent_tab_id=display_tab.id,
    )

    listed = await _build_tab_list(None)
    listed_ids = {t.id for t in listed}
    assert display_tab.id not in listed_ids, (
        "a display-pointer row must be reaped by pointer shape even though its "
        "target process is alive"
    )
    assert shell_tab.id in listed_ids, "the process's shell tab must survive"
    assert await Tab.get_one({"id": display_tab.id}) is None, "display row hard-deleted"
    fresh_child = await Tab.get_one({"id": child.id})
    assert fresh_child is not None
    assert fresh_child.parent_tab_id == shell_tab.id, (
        "children of the reaped display row re-anchor to the same target's shell tab"
    )


@pytest.mark.asyncio
async def test_display_row_reap_nulls_children_without_shell_sibling() -> None:
    from flow_sdk.builtin.tab import _build_tab_list

    proc = await _live_process()
    apid = str(proc.id)
    display_tab = await _seed_tab(
        f'{{"viewType": "display", "pointer": "agentic_process-{apid}"}}',
        target_type="agentic_process",
        target_id=apid,
    )
    child = await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-nullheal"}',
        target_type="markdown",
        target_id="md-nullheal",
        parent_tab_id=display_tab.id,
    )

    await _build_tab_list(None)
    assert await Tab.get_one({"id": display_tab.id}) is None
    fresh_child = await Tab.get_one({"id": child.id})
    assert fresh_child is not None
    assert fresh_child.parent_tab_id is None, (
        "with no shell sibling the child's dangling parent edge is nulled"
    )


@pytest.mark.asyncio
async def test_legacy_pipe_format_display_pointer_is_reaped() -> None:
    from flow_sdk.builtin.tab import _build_tab_list

    proc = await _live_process()
    apid = str(proc.id)
    legacy = await _seed_tab(
        f"display|agentic_process-{apid}",
        target_type="agentic_process",
        target_id=apid,
    )
    listed = await _build_tab_list(None)
    assert legacy.id not in {t.id for t in listed}
    assert await Tab.get_one({"id": legacy.id}) is None


@pytest.mark.asyncio
async def test_dangling_parent_edge_is_healed_on_list() -> None:
    # A child whose parent row does not EXIST at all (minted under a row a
    # previous reap cycle had already deleted — the old-client upgrade window).
    # Distinct from a soft-closed parent, which is a legitimate group edge.
    from flow_sdk.builtin.tab import _build_tab_list

    ghost_parent_id = str(uuid.uuid4())
    child = await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-dangling"}',
        target_type="markdown",
        target_id="md-dangling",
        parent_tab_id=ghost_parent_id,
    )
    await _build_tab_list(None)
    fresh = await Tab.get_one({"id": child.id})
    assert fresh is not None
    assert fresh.parent_tab_id is None, "a parent edge to a nonexistent row must be healed"


@pytest.mark.asyncio
async def test_soft_closed_parent_edge_is_preserved_on_list() -> None:
    # Counterpart of the dangling heal: a HIDDEN (soft-closed) parent still
    # exists — the deterministic id regroups on reopen, so the edge must stay.
    from flow_sdk.builtin.tab import _build_tab_list

    parent = await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-softparent"}',
        target_type="markdown",
        target_id="md-softparent",
    )
    child = await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-softchild"}',
        target_type="markdown",
        target_id="md-softchild",
        parent_tab_id=parent.id,
    )
    parent.visible = False
    await parent.save()

    await _build_tab_list(None)
    fresh = await Tab.get_one({"id": child.id})
    assert fresh is not None
    assert fresh.parent_tab_id == parent.id, "a soft-closed parent is a live group edge"


@pytest.mark.asyncio
async def test_reap_cycle_emits_single_broadcast() -> None:
    from unittest.mock import AsyncMock, patch

    import flow_sdk.builtin.tab as tab_mod
    from flow_sdk.builtin.tab import _build_tab_list

    proc = await _live_process()
    apid = str(proc.id)
    await _seed_tab(
        f'{{"viewType": "shell", "pointer": "agentic_process-{apid}"}}',
        target_type="agentic_process",
        target_id=apid,
    )
    display_tab = await _seed_tab(
        f'{{"viewType": "display", "pointer": "agentic_process-{apid}"}}',
        target_type="agentic_process",
        target_id=apid,
    )
    await _seed_tab(
        '{"viewType": "assets", "pointer": "editor/markdown/typeid/markdown-bcast"}',
        target_type="markdown",
        target_id="md-bcast",
        parent_tab_id=display_tab.id,
    )
    # A target-orphan alongside, so multiple reap kinds fire in ONE cycle.
    ghost = str(uuid.uuid4())
    await _seed_tab(
        f"shell/agentic_process-{ghost}",
        target_type="agentic_process",
        target_id=ghost,
    )

    with patch.object(tab_mod, "broadcast_tabs_changed", new=AsyncMock()) as bc:
        await _build_tab_list(None)
        assert bc.await_count == 1, (
            f"one reap cycle must coalesce to a single tabs_changed ping, got {bc.await_count}"
        )
