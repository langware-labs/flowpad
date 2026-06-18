"""Tab entity — a DB-only placement record for one content-panel tab.

A "tab" is no longer piggy-backed onto whatever entity it shows (the old
base-Entity ``tabbed`` flag). It is a first-class row keyed by a **hash of the
DockPointer it opens** (docs/tab-management.md). Every ``openDock`` get-or-creates
a visible Tab; closing flips ``visible=false`` (soft — rides the non-null wire
rule); the strip is one live query of ``visible=true`` Tabs.

Identity is deterministic (uuid5 via ``mint_uuid``) over the canonical pointer
string. Canonicalization — *which* pointers collapse to one tab — is the single
knob, and it lives in exactly one place: the frontend ``DockPointer.tabHash``.
The backend treats that string as an opaque natural key, so there is no
cross-language canonicalizer to keep in agreement. ``target_type``/``target_id``
are denormalized off the pointer by the caller for fast reverse lookup (e.g.
close-on-target-delete); they are never an independent source of truth.

Like ``File``, this type is DB-only: no asset_ref, no FSRecord, never walked and
never orphan-swept. It is a SQLite row, so it survives a normal restart; only an
explicit rebuild-from-disk drops it (``tab_order`` is ``Persist.FALSE`` and is
expected to reset on such a rebuild anyway).
"""

from __future__ import annotations

import json as _json
import uuid

from flow_sdk.actions.action_registry import action as _action_registry
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.builtin.tab_order import (
    compute_insert_new,
    compute_reorder,
    filter_for_project,
)
from flow_sdk.core import Entity
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.schema.types import EntityType


def _pointer_to_hash(pointer: str) -> str:
    """Extract the canonical 'viewType|sub' identity string from either format:
    - new: JSON {"viewType": ..., "pointer": ...}
    - old: legacy "viewType|sub" string (backward compat during migration)

    This ensures UUID5 remains stable across the format transition.
    """
    if pointer.startswith('{'):
        try:
            data = _json.loads(pointer)
            vt = data.get('viewType', '')
            sub = data.get('pointer', '')
            return f"{vt}|{sub}"
        except (ValueError, TypeError):
            return pointer
    return pointer


def tab_id_for(pointer: str) -> str:
    """Deterministic Tab id (uuid5) for a canonical pointer string.

    The ``tab:`` scheme prefix keeps the Tab keyspace disjoint from every other
    ``mint_uuid`` caller that uses ``NAMESPACE_URL``. The pointer can be in either
    new JSON format or legacy "viewType|sub" format — UUID5 is keyed on the
    canonical hash extracted from it, so it remains stable across migration.
    """
    hash_str = _pointer_to_hash(pointer)
    return mint_uuid(key=f"tab:{hash_str}", namespace=uuid.NAMESPACE_URL)


class Tab(Entity):
    type: str = APIField(default=EntityType.TAB.value)

    # Canonical serialized DockPointer (frontend ``DockPointer.tabHash``). The
    # natural key — Tab.id == uuid5("tab:"+pointer). Opaque to the backend.
    pointer: str = APIField(default="")
    # Denormalized target identity, derived from the pointer by the caller for
    # fast reverse lookup. Null for target-less surfaces (settings/search/diff).
    target_type: str | None = APIField(default=None)
    target_id: str | None = APIField(default=None)

    # Display primitives the strip draws straight off the Tab, so the chip never
    # has to fetch its backing Shell/AgenticProcess (docs/tab-management.md). Both
    # are CREATE-only and static for a tab's life:
    #   ``icon_key`` — resolved provider/display kind ('shell'|'claude'|'codex'|
    #                  'copilot'), set at creation from the target's worker_type.
    #                  (Named ``icon_key`` not ``icon`` — the latter is the base
    #                  Entity's type-icon accessor.)
    #   ``worktree`` — whether the backing process runs in a git worktree (badge).
    icon_key: str | None = APIField(default=None)
    worktree: bool = APIField(default=False)

    # Strip ordering (0 = unassigned). DB-only — intentionally does not survive
    # a rebuild-from-disk (tab-management.md Part 1, decision 3).
    tab_order: int = APIField(default=0, persist=Persist.FALSE)
    # Epoch-ms of last activation, stamped server-side by the generic
    # ``activate`` action. Resolver recency seed only (resolveActive case 3) —
    # never read to highlight the active tab; the URL is active truth.
    last_active_at: int | None = APIField(default=None)

    # Visibility = tab membership. Non-null by design: a close must broadcast as
    # ``visible=false`` — the wire encoder strips nulled fields (exclude_none)
    # and the receiver merge never clears absent keys, so a null signal cannot
    # propagate cross-client. Never model close as delete or ``visible=None``.
    visible: bool = APIField(default=True)

    # Runtime-computed fields: populated at query time from the backing entity.
    # Never persisted — re-resolved on every list/close/rename action.
    status: str | None = APIField(default=None, persist=Persist.FALSE)
    is_disabled: bool = APIField(default=False, persist=Persist.FALSE)

    # ``name`` and ``project_id`` are inherited from the base Entity. ``name`` is
    # the generic source of truth for the tab label; ``rename`` reflects it onto
    # the backing entity via the generic ``Entity.rename`` (shell/AP override to
    # also pin ``auto_rename``).
    #
    # No ``allocate_id`` override: it is only consulted by ``from_record`` (the
    # disk→DB re-index path), which a DB-only entity never takes. Identity is
    # owned by ``ensure_tab`` below, which mints ``tab_id_for(pointer)`` and
    # passes it as the explicit ``id`` — exactly the ``File`` pattern.

    async def close(self) -> None:
        """Soft-close: hide the tab and dispatch per-target-type teardown.

        ``visible=False`` is the membership-removal signal — non-null so it
        broadcasts (never delete-to-close). Then teardown is dispatched **by
        target_type, not by an inline ``if name==``** (slick P6): the target
        entity owns its own ``teardown_for_tab`` (e.g. a shell/agentic_process
        tears down its PTY/worker; a markdown/skill survives untouched). A
        target without that method is a no-op.
        """
        self.visible = False
        await self.save()
        await self._dispatch_teardown()

    async def _dispatch_teardown(self) -> None:
        target = await self._target_entity()
        teardown = getattr(target, "teardown_for_tab", None)
        if target is not None and callable(teardown):
            await teardown()

    async def set_label(self, name: str) -> None:
        """Set ONLY the Tab label — no target reflect, no ``auto_rename`` change.

        The PTY auto-title mirror: the active panel already saved the live name onto
        its Shell/AgenticProcess; this keeps the durable ``Tab.name`` in step so the
        chip stays right once inactive. Unlike :meth:`rename`, it must NOT touch the
        target (which would pin ``auto_rename=False`` and stop future auto-titles)."""
        if name and self.name != name:
            self.name = name
            await self.save()

    async def rename(self, name: str) -> None:
        """``Tab.name`` is the generic source of truth for the tab label. Set it,
        then reflect onto the backing entity by calling its generic ``rename`` —
        base ``Entity.rename`` adopts the name onto ANY target (conversation,
        agentic_process, shell, markdown, …); shell/agentic_process override it
        to also pin ``auto_rename=False`` (and the FE sends the PTY ``/rename``).
        Dispatch is by method, not by ``if target_type==`` (slick P6) — exactly
        like ``close`` → ``teardown_for_tab``. A target-less tab keeps the label
        on the Tab alone.
        """
        self.name = name
        await self.save()
        target = await self._target_entity()
        if target is not None:
            await target.rename(name)

    async def _target_entity(self):
        if not (self.target_type and self.target_id):
            return None
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        entity_cls = SchemaRegistry.get_entity_cls(self.target_type)
        if entity_cls is None:
            return None
        return await entity_cls.get_one({"id": self.target_id})


async def _visible_tabs_sorted() -> list[Tab]:
    """Every visible Tab in canonical GLOBAL order (``tab_order`` asc, ``id`` as
    the deterministic tiebreak so legacy ``tab_order==0`` rows never reshuffle)."""
    tabs = await Tab.get_all({"visible": True})
    tabs.sort(key=lambda t: (getattr(t, "tab_order", 0) or 0, t.id))
    return tabs


async def _persist_global_order(new_order: list[str], by_id: dict[str, Tab]) -> bool:
    """Assign ``tab_order = contiguous index`` over ``new_order``; save only rows
    whose index changed (no-op order ⇒ no write). Returns whether anything wrote."""
    wrote = False
    for idx, tid in enumerate(new_order):
        tab = by_id.get(tid)
        if tab is not None and getattr(tab, "tab_order", 0) != idx:
            tab.tab_order = idx
            await tab.save()
            wrote = True
    return wrote


async def ensure_tab(
    pointer: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    project_id: str | None = None,
    name: str | None = None,
    icon_key: str | None = None,
    worktree: bool | None = None,
    after_tab_id: str | None = None,
) -> Tab:
    """Deterministic get-or-create for a tab, keyed by the canonical pointer.

    On reopen (same pointer) the existing row is reused and re-shown
    (``visible=True``); the denormalized target/project/name hints are refreshed
    but identity and ``tab_order`` never change (reopen keeps its slot). On a
    fresh create the new tab is placed **immediately after ``after_tab_id``** (the
    opener / current active tab) in the global order, else appended last. Models
    ``ensure_file_entity``.
    """
    tid = tab_id_for(pointer)
    # Reconcile by the natural key (``pointer``), NOT just the derived id. The id
    # is ``tab_id_for(pointer)`` (uuid5) — a derivation, not the identity. A row
    # minted under the old client-side scheme carries a random uuid4 id that never
    # equals ``tab_id_for(pointer)``, so an id-only lookup misses it and mints a
    # *second* canonical row → two visible chips for one pointer. Query the pointer:
    # reuse the canonical (``id == tid``) row, and soft-hide any foreign-id strays
    # sharing that pointer so a pre-existing duplicate self-heals on next open.
    same_pointer = await Tab.get_all({"pointer": pointer})
    existing = next((t for t in same_pointer if t.id == tid), None)
    for stray in same_pointer:
        if stray.id != tid and stray.visible:
            stray.visible = False
            await stray.save()
    if existing is not None:
        dirty = False
        # Heal legacy "viewType|sub" pointers on access — migrate to JSON format
        if existing.pointer and not existing.pointer.startswith('{'):
            parts = existing.pointer.split('|', 1)
            vt = parts[0] if parts else ''
            sub = parts[1] if len(parts) > 1 else ''
            existing.pointer = _json.dumps({"viewType": vt, "pointer": sub})
            dirty = True
        if not existing.visible:
            existing.visible = True
            dirty = True
        for attr, val in (
            ("target_type", target_type),
            ("target_id", target_id),
            ("project_id", project_id),
        ):
            if val is not None and getattr(existing, attr) != val:
                setattr(existing, attr, val)
                dirty = True
        # Backfill display primitives ONLY when the row has none — a null name
        # was never a user rename, and a null icon_key/worktree predates the
        # field, so filling heals legacy rows on next open without clobbering a
        # user-chosen name.
        if not existing.name and name:
            existing.name = name
            dirty = True
        if not existing.icon_key and icon_key:
            existing.icon_key = icon_key
            dirty = True
        if not existing.worktree and worktree:
            existing.worktree = True
            dirty = True
        if dirty:
            await existing.save()
        return existing
    # Fresh create: place the new tab in the GLOBAL order — immediately after the
    # opener. ``after_tab_id`` is the explicit opener when given; otherwise the
    # opener defaults to the most-recently-active visible tab (browser-style: a
    # tab opened from within a tab lands right after the one you were on). No tabs
    # yet ⇒ append. tab_order is the contiguous index; only shifted rows re-save.
    visible = await _visible_tabs_sorted()
    existing_ids = [t.id for t in visible]
    if after_tab_id is None:
        # Only an ACTIVATED tab is a real opener; with none (cold open / restore)
        # we append rather than wedge after an arbitrary first row.
        activated = [t for t in visible if t.last_active_at]
        if activated:
            after_tab_id = max(activated, key=lambda t: t.last_active_at or 0).id
    tab = Tab(
        id=tid,
        pointer=pointer,
        target_type=target_type,
        target_id=target_id,
        project_id=project_id,
        name=name,
        icon_key=icon_key,
        worktree=bool(worktree),
        visible=True,
    )
    new_order = compute_insert_new(existing_ids, tid, after_tab_id)
    # Shift the existing rows whose index moved (reuses the reorder persister); the
    # new row isn't in ``by_id`` so it's set + saved once here, covering append (its
    # index never "changed" from 0) and insert alike.
    tab.tab_order = new_order.index(tid)
    await _persist_global_order(new_order, {t.id: t for t in visible})
    await tab.save()
    return tab


async def hide_tabs_for_target(target_type: str, target_id: str) -> None:
    """Membership-only soft-close of every visible Tab denormalized onto a
    target entity (``target_type`` + ``target_id``): flip ``visible=False`` and
    save, WITHOUT dispatching ``Tab.close``'s per-target-type teardown.

    Use this from a target's OWN lifecycle teardown that does not delete the
    entity — e.g. ``AgenticProcess.close`` stops the worker but the process row
    persists as ``stopped``, so the generic delete → orphan-Tab cleanup in
    ``Entity.delete`` never fires and the chip would linger. Teardown is already
    underway at the call site, so routing through ``Tab.close`` here would
    re-enter that teardown — hence the direct flag flip.
    """
    try:
        tabs = await Tab.get_all({"target_type": target_type, "target_id": str(target_id)})
    except Exception:
        return
    hid = False
    for tab in tabs:
        if getattr(tab, "visible", False):
            tab.visible = False
            await tab.save()
            hid = True
    if hid:
        # Background death (worker stop / orphan cleanup) — ping clients to refetch
        # so the chip drops without waiting for the next navigation.
        await broadcast_tabs_changed()


# ── Backend-owned tab list (the single render source) ──────────────────────────
#
# The frontend strip no longer derives order or overlays live entity state from a
# reactive query: it renders exactly the rows this module returns. So every list
# row is fully resolved here (label + display primitives + live status), already
# in global order, optionally filtered to one project's view.


async def _resolve_status(tab: Tab) -> str | None:
    """Best-effort live status for the chip (``closing`` ⇒ disabled affordance).
    Duck-typed: a Shell carries ``status``; an AgenticProcess defers to its linked
    shell (``shell_id``). Absent/unknown ⇒ ``None`` (enabled).

    Only terminal targets carry a status, so content/target-less tabs short-circuit
    BEFORE the ``_target_entity`` DB read — the list path resolves no entity for the
    ~majority of rows (markdown/asset/settings/search/diff)."""
    if tab.target_type not in (EntityType.SHELL.value, EntityType.AGENTIC_PROCESS.value):
        return None
    target = await tab._target_entity()
    if target is None:
        return None
    status = getattr(target, "status", None)
    if status is None:
        shell_id = getattr(target, "shell_id", None)
        if shell_id:
            from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

            shell_cls = SchemaRegistry.get_entity_cls("shell")
            if shell_cls is not None:
                shell = await shell_cls.get_one({"id": shell_id})
                status = getattr(shell, "status", None)
    return str(status) if status is not None else None


def _normalize_project(project: str | None) -> str | None:
    """Treat empty/``"null"`` as the no-active-project (projectless) view."""
    if project in (None, "", "null"):
        return None
    return project


async def _populate_tab_statuses(tabs: list[Tab]) -> None:
    """Populate status and is_disabled fields on a list of Tabs (in-place mutation).
    Called before serialization to ensure every Tab carries current status from its backing entity."""
    for tab in tabs:
        tab.status = await _resolve_status(tab)
        tab.is_disabled = tab.status == "closing"


async def _build_tab_list(project: str | None) -> list[Tab]:
    """The ordered, project-filtered list of Tabs with runtime status resolved.
    Global order filtered to ``{project OR projectless}`` (decision 3), each Tab
    fully populated with status/is_disabled. The Tab objects are serialized
    directly for API responses — no separate projection."""
    tabs = await _visible_tabs_sorted()
    order_ids = [t.id for t in tabs]
    project_of: dict[str, str | None] = {t.id: t.project_id for t in tabs}
    filtered = filter_for_project(order_ids, project_of, _normalize_project(project))
    by_id = {t.id: t for t in tabs}
    result = [by_id[tab_id] for tab_id in filtered]
    await _populate_tab_statuses(result)
    return result


# Stable sentinel TypeId for the global ping. ``flow_data_msg`` is dropped client-
# side unless ``to_entity`` parses as ``<type>-<uuid>`` (websocket.parseTypeId), so
# we ride a fixed Tab id; the frontend keys on ``element_type``, never this id.
_TABS_CHANGED_SIGNAL = f"tab-{tab_id_for('__tabs_changed_signal__')}"


async def broadcast_tabs_changed() -> None:
    """Global ``tabs-changed`` ping so every client refetches the list — covers
    backend-originated changes (death/orphan-cleanup, rename, second window). Uses
    the watcher-less broadcast channel (same path as scan/upload progress)."""
    from flow_sdk.core.network.resource_tracker import broadcast_progress  # noqa: PLC0415

    await broadcast_progress(
        to_entity=_TABS_CHANGED_SIGNAL,
        flow_data={"element_type": "tabs_changed", "attributes": {}},
    )


async def _list_response(project: str | None):
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    tabs = await _build_tab_list(project)
    return ApiSuccessResponse(data={"tabs": [t.model_dump(mode="json") for t in tabs]})


async def _http_new_tab(
    cls,
    pointer: str,
    target_type: str | None = None,
    target_id: str | None = None,
    project_id: str | None = None,
    name: str | None = None,
    icon_key: str | None = None,
    worktree: bool = False,
    after_tab_id: str | None = None,
):
    """POST /graph/tab/new_tab — loader-driven get-or-create. A fresh tab lands
    right after ``after_tab_id`` (the opener); reopen keeps its slot. Returns the
    updated project-filtered list."""
    await ensure_tab(
        pointer,
        target_type=target_type,
        target_id=target_id,
        project_id=project_id,
        name=name,
        icon_key=icon_key,
        worktree=worktree,
        after_tab_id=after_tab_id,
    )
    await broadcast_tabs_changed()
    return await _list_response(project_id)


_action_registry.register(
    action_name="new_tab",
    function_name="new_tab",
    handler=_http_new_tab,
    methods="post",
    types=["tab"],
)


async def _http_list(cls, project: str | None = None):
    """GET /graph/tab/list?project=<id> — the deterministic, fully-resolved,
    ordered render list for one project view (projectless tabs inline)."""
    return await _list_response(project)


_action_registry.register(
    action_name="list",
    function_name="list",
    handler=_http_list,
    methods="get",
    types=["tab"],
)


async def _http_list_all(cls):
    """GET /graph/tab/list_all — EVERY visible Tab (any kind, ALL projects), fully
    resolved, in global order.

    The project-scoped ``list`` is ``{that project} + projectless`` and ``list(None)``
    is projectless-only, so neither gives the global picture that the developer
    sessions view (``/dev``) and the footer projects-chip need. This is the single
    unscoped projection (via the ``tab`` action, refreshed on the ``tabs_changed``
    ping) that replaces the old reactive ``tab?visible=true`` entity query."""
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    tabs = await _visible_tabs_sorted()
    await _populate_tab_statuses(tabs)
    return ApiSuccessResponse(data={"tabs": [t.model_dump(mode="json") for t in tabs]})


_action_registry.register(
    action_name="list_all",
    function_name="list_all",
    handler=_http_list_all,
    methods="get",
    types=["tab"],
)


async def _http_order(
    cls,
    reorder_tab_id: str,
    after_tab_id: str | None = None,
    before_tab_id: str | None = None,
    project: str | None = None,
):
    """POST /graph/tab/order — drag-drop commit. Splices ``reorder_tab_id`` into
    the drop-gap within the GLOBAL order, persists only changed rows (no-op ⇒ no
    write/broadcast), and returns the updated project-filtered list."""
    tabs = await _visible_tabs_sorted()
    by_id = {t.id: t for t in tabs}
    if reorder_tab_id in by_id:
        order_ids = [t.id for t in tabs]
        new_order = compute_reorder(order_ids, reorder_tab_id, after_tab_id, before_tab_id)
        if await _persist_global_order(new_order, by_id):
            await broadcast_tabs_changed()
    return await _list_response(project)


_action_registry.register(
    action_name="order",
    function_name="order",
    handler=_http_order,
    methods="post",
    types=["tab"],
)


async def _http_close(self: Tab):
    """POST /graph/tab/<id>/close — soft-close then return the updated list."""
    await self.close()
    await broadcast_tabs_changed()
    return await _list_response(self.project_id)


_action_registry.register(
    action_name="close",
    function_name="close",
    handler=_http_close,
    methods="post",
    types=["tab"],
)


async def _http_rename(self: Tab):
    """POST /graph/tab/<id>/rename {name} — rename then return the updated list."""
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

    request_info = get_current_request_info()
    body = (await request_info.get_post_data() if request_info is not None else {}) or {}
    name = body.get("name") or ""
    await self.rename(name)
    await broadcast_tabs_changed()
    return await _list_response(self.project_id)


_action_registry.register(
    action_name="rename",
    function_name="rename",
    handler=_http_rename,
    methods="post",
    types=["tab"],
)


async def _http_set_name(self: Tab):
    """POST /graph/tab/<id>/set_name {name} — set ONLY the Tab label, no entity
    reflect and no ``auto_rename`` change.

    This is the PTY auto-title mirror (OSC title → chip): the active panel already
    saved the live name onto its Shell/AgenticProcess; this keeps the durable
    ``Tab.name`` in step so the chip stays correct once it goes inactive. It must
    NOT route through ``rename`` — that pins ``auto_rename=False`` on the target and
    would stop all future auto-titles."""
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

    request_info = get_current_request_info()
    body = (await request_info.get_post_data() if request_info is not None else {}) or {}
    name = body.get("name") or ""
    before = self.name
    await self.set_label(name)
    if self.name != before:
        await broadcast_tabs_changed()
    return await _list_response(self.project_id)


_action_registry.register(
    action_name="set_name",
    function_name="set_name",
    handler=_http_set_name,
    methods="post",
    types=["tab"],
)
