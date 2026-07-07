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
import logging
import uuid

from flow_sdk.actions.action_registry import action as _action_registry
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.builtin.tab_order import (
    compute_insert_new,
    compute_reorder,
    filter_for_project,
)
from flow_sdk.core import Entity
from flow_sdk.fs_store.identifier import is_valid_uuid, mint_uuid
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)

# Sentinel for ``ensure_tab(project_id=...)``: distinguishes "caller didn't pass
# a project hint" (keep the existing value on reopen) from an EXPLICIT ``None``
# (the target is now projectless → clear the stale snapshot). A plain ``None``
# default could only mean the former, which is why a re-derived projectless tab
# never cleared.
_UNSET: object = object()


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

    # Advisory grouping edge to the opener tab (the vibe display tab is the first
    # consumer). Never affects ordering/close/recency; children stay ordinary
    # global tabs. Nulled only on hard reap (see ``_clear_parent_refs``) — a
    # soft-closed parent leaves it dangling-but-inert, and the deterministic
    # uuid5 id regroups children when the parent's pointer reopens.
    parent_tab_id: str | None = APIField(default=None)

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
        return await _load_target_entity(self.target_type, self.target_id)


async def _visible_tabs_sorted_with_targets() -> (
    "tuple[list[Tab], dict[tuple[str, str], object]]"
):
    """``_visible_tabs_sorted`` plus the batched SHELL/AGENTIC_PROCESS target map
    it already loaded to reap. The hot read paths (``_build_tab_list`` /
    ``list_all``) thread that map into ``_populate_tab_statuses`` so the status
    fill reuses it instead of re-running the same ``id IN (…)`` loads — one set
    of target queries per request, not two."""
    tabs = await Tab.get_all({"visible": True})
    target_map, verified_types = await _load_status_targets(tabs)
    tabs = await _reap_orphans(tabs, target_map, verified_types)
    tabs.sort(key=lambda t: (getattr(t, "tab_order", 0) or 0, t.id))
    return tabs, target_map


async def _visible_tabs_sorted() -> list[Tab]:
    """Every visible Tab in canonical GLOBAL order (``tab_order`` asc, ``id`` as
    the deterministic tiebreak so legacy ``tab_order==0`` rows never reshuffle)."""
    tabs, _ = await _visible_tabs_sorted_with_targets()
    return tabs


async def _project_exists(project_id: str | None) -> bool:
    if not project_id:
        return True
    try:
        uuid.UUID(str(project_id))
    except (TypeError, ValueError):
        # Legacy/test project identifiers are not reliable Project primary keys;
        # only UUID-shaped project refs are eligible for stale-row deletion.
        return True
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        return await Project.get_by_id(str(project_id)) is not None
    except Exception:
        # Fail open: a transient project lookup problem must not hard-delete tabs.
        return True


async def delete_tabs_for_missing_project(project_id: str | None) -> int:
    """Hard-delete stale Tab rows whose owning project no longer exists.

    This is intentionally different from user-initiated tab close. Close remains
    a soft membership change and may dispatch target teardown; stale project
    cleanup removes only dangling Tab rows via ``Tab.delete()`` and never calls
    ``Tab.close()``.
    """
    if await _project_exists(project_id):
        return 0
    try:
        tabs = await Tab.get_all({"project_id": str(project_id)})
    except Exception:
        return 0
    deleted = 0
    for tab in tabs:
        try:
            await tab.delete()
        except Exception:
            continue
        deleted += 1
    if deleted:
        await broadcast_tabs_changed()
    return deleted


async def _load_status_targets(
    tabs: list[Tab],
) -> "tuple[dict[tuple[str, str], object], set[str]]":
    """Batch-load the SHELL and AGENTIC_PROCESS target entities referenced by
    ``tabs`` — ONE ``id IN (…)`` query per type, vs a ``get_one`` per tab.

    These are the only target types that carry a chip ``status`` and the only
    ones the orphan-target reaper validates, so a single load serves both the
    status fill (``_populate_tab_statuses``) and the missing-target reap
    (``_reap_orphans``) — killing the previous double-read of every
    agentic_process row.

    Returns ``(by_type_id, verified_types)``. ``verified_types`` lists the types
    whose query actually ran (or had nothing to load) — a type whose load raised
    is omitted so the reaper treats its tabs as "could not determine" and leaves
    them alone, exactly like the old per-tab ``except: continue`` fail-open.
    """
    from flow_sdk.db.drivers.query import (  # noqa: PLC0415
        ExpressionNode,
        QueryFilter,
        QueryOp,
    )
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    by_type_id: dict[tuple[str, str], object] = {}
    verified: set[str] = set()
    for t in _DB_BACKED_TARGET_TYPES:
        ids = sorted(
            {str(tab.target_id) for tab in tabs if tab.target_type == t and tab.target_id}
        )
        if not ids:
            verified.add(t)  # nothing referenced == fully known
            continue
        cls = SchemaRegistry.get_entity_cls(t)
        if cls is None:
            continue
        try:
            rows = await cls.get_all(
                QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", ids]))
            )
        except Exception:
            logger.debug("tab status-target batch load failed for %s", t, exc_info=True)
            continue
        for r in rows:
            by_type_id[(t, str(r.id))] = r
        verified.add(t)
    return by_type_id, verified


async def _existing_project_ids(tabs: list[Tab]) -> "tuple[set[str], set[str], bool]":
    """Resolve which of the tabs' project ids still exist, via ONE ``id IN (…)``
    query (vs a ``get_by_id`` per distinct project).

    Returns ``(existing_ids, candidate_ids, ok)`` where ``candidate_ids`` is the
    set of distinct UUID-shaped ``project_id``s (the only ones eligible for
    reaping — legacy/non-UUID ids aren't reliable Project keys, same rule as
    ``_project_exists``) and ``existing_ids`` is the subset of those that exist.
    The caller reaps ``candidate_ids - existing_ids`` without re-validating shape.
    ``ok`` is ``False`` if the lookup raised, so the caller fails open and reaps
    nothing.
    """
    candidates = {
        str(t.project_id)
        for t in tabs
        if getattr(t, "project_id", None) and is_valid_uuid(str(t.project_id))
    }
    if not candidates:
        return set(), candidates, True
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.db.drivers.query import (  # noqa: PLC0415
        ExpressionNode,
        QueryFilter,
        QueryOp,
    )

    try:
        rows = await Project.get_all(
            QueryFilter(
                match=ExpressionNode(op=QueryOp.IN, operands=["id", sorted(candidates)])
            )
        )
    except Exception:
        logger.debug("tab project-existence batch load failed", exc_info=True)
        return set(), candidates, False
    return {str(r.id) for r in rows}, candidates, True


async def _reap_orphans(
    tabs: list[Tab],
    target_map: "dict[tuple[str, str], object] | None" = None,
    verified_types: "set[str] | None" = None,
) -> list[Tab]:
    """Drop — and hard-delete the rows for — tabs orphaned by a missing project
    or a missing shell/agentic_process target. Replaces the old pair of per-row
    reapers (``_delete_tabs_for_missing_projects`` / ``…_targets``).

    Orphan detection is in-memory off two batched ``id IN (…)`` loads (projects
    and the shell/agentic_process targets — the latter shared with the status fill
    via ``target_map``), so the list READ costs O(1) queries instead of
    O(distinct-projects + live-session-tabs) ``get_one``s. Writes fire ONLY
    when something is genuinely orphaned (rare), so the steady-state read writes
    nothing.

    Fail-open preserved: a project lookup that raised reaps no project orphans;
    a target type whose batch load raised (absent from ``verified_types``) reaps
    no orphans of that type — never mass-delete on a transient read error.

    The reaped target types are exactly ``_DB_BACKED_TARGET_TYPES`` (shell +
    agentic_process): those rows are always DB-backed, so absence == orphan,
    whereas a missing ``markdown``/asset target is a valid unindexed-but-on-disk
    row (see ``_backfill_tab_projects``) and is left alone.
    """
    if not tabs:
        return tabs
    if target_map is None or verified_types is None:
        target_map, verified_types = await _load_status_targets(tabs)
    existing_projects, candidate_projects, projects_ok = await _existing_project_ids(tabs)

    deleted_ids: set[str] = set()

    # Missing PROJECT: reap every tab (visible AND hidden) of each absent project
    # via the shared per-project reaper, so a deleted project leaves no dangling
    # rows behind — not just the ones currently visible. Fires only for a
    # genuinely missing project, so the steady-state read does no extra work.
    if projects_ok:
        for pid in sorted(candidate_projects - existing_projects):
            await delete_tabs_for_missing_project(pid)
            deleted_ids.update(
                t.id for t in tabs if str(getattr(t, "project_id", None)) == pid
            )

    # Missing TARGET: a shell/agentic_process tab whose entity row is absent.
    # BOTH live-session target types (``_DB_BACKED_TARGET_TYPES``) are ALWAYS
    # DB-backed, so a missing row means the session is genuinely gone — never a
    # valid unindexed-on-disk state (unlike a markdown/asset target, which is why
    # those are NOT reaped). A ``close``d shell soft-hides its Tab via the generic
    # orphan-close, but a reload whose active URL points at that now-deleted shell
    # re-mints the row through ``ensure_tab`` (visible again); reaping shell here —
    # not just agentic_process — is what finally drops that resurrected chip.
    # Per-type gate on ``verified_types`` keeps the fail-open: a type whose batch
    # load raised is omitted, so its tabs are left alone rather than mass-deleted.
    target_orphans = [
        t
        for t in tabs
        if t.id not in deleted_ids
        and t.target_type in _DB_BACKED_TARGET_TYPES
        and t.target_type in verified_types
        and t.target_id
        and (t.target_type, str(t.target_id)) not in target_map
    ]
    reaped_target = False
    for tab in target_orphans:
        try:
            await tab.delete()
        except Exception:
            continue
        deleted_ids.add(tab.id)
        reaped_target = True
    if reaped_target:
        # Background reap (no user navigation) — ping clients so the dangling
        # chip drops live instead of waiting for the next list fetch.
        await broadcast_tabs_changed()
    # Null any child ``parent_tab_id`` pointing at a hard-deleted row so no
    # permanently-dangling group edges accumulate (soft-close leaves them intact
    # by design — the id is deterministic and regroups on reopen; only a real
    # delete is terminal). Fires only when something was actually reaped.
    if deleted_ids:
        await _clear_parent_refs(deleted_ids)
    return [t for t in tabs if t.id not in deleted_ids]


async def _clear_parent_refs(parent_ids: "set[str]") -> None:
    """Null ``parent_tab_id`` on every tab whose parent was hard-deleted. Rare
    path (only on genuine reap); best-effort, one query per gone parent."""
    changed = False
    for pid in parent_ids:
        try:
            children = await Tab.get_all({"parent_tab_id": pid})
        except Exception:
            continue
        for child in children:
            child.parent_tab_id = None
            try:
                await child.save()
                changed = True
            except Exception:
                continue
    if changed:
        await broadcast_tabs_changed()


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


async def _project_of_target(target_type: str, target_id: str) -> str | None:
    """The owning ``project_id`` of a tab's target, resolved SERVER-SIDE so the
    chip never depends on a client cache read that can miss. Thin alias over the
    entity-agnostic ``Entity.project_id_of`` primitive (shared with
    ``Conversation.resolve_project_id``)."""
    return await Entity.project_id_of(target_type, target_id)


# The two live-session target types: their rows are ALWAYS DB-backed, so absence
# == the session is gone (never a valid unindexed-on-disk state). They are also
# the only status-bearing tab targets, and (because absence is unambiguous) the
# exact set ``_reap_orphans`` reaps a missing target for.
_DB_BACKED_TARGET_TYPES = (EntityType.SHELL.value, EntityType.AGENTIC_PROCESS.value)


async def _load_target_entity(target_type: str | None, target_id: str | None):
    """Resolve the backing entity row for a tab target (None if unresolvable)."""
    if not (target_type and target_id):
        return None
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    entity_cls = SchemaRegistry.get_entity_cls(target_type)
    if entity_cls is None:
        return None
    return await entity_cls.get_one({"id": str(target_id)})


async def ensure_tab(
    pointer: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    project_id: "str | None" = _UNSET,  # type: ignore[assignment]
    name: str | None = None,
    icon_key: str | None = None,
    worktree: bool | None = None,
    after_tab_id: str | None = None,
    parent_tab_id: str | None = None,
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
    # Backend authority for the chip's project: the client computes ``project_id``
    # from a cache-first target read that MISSES on a cold/bare open (e.g. an
    # unindexed claude-session lens — the row only resolves via on-disk recovery),
    # so it passes null and the chip renders project-less ("stays blue") even
    # though the target HAS a project. When the client didn't supply a usable
    # project, resolve it from the target entity server-side (``reconcile_tab_project``
    # keeps it fresh on later target-project changes).
    if (project_id is _UNSET or not project_id) and target_type and target_id:
        resolved = await _project_of_target(target_type, target_id)
        if resolved:
            project_id = resolved
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
        ):
            if val is not None and getattr(existing, attr) != val:
                setattr(existing, attr, val)
                dirty = True
        # ``project_id`` is re-derived from the target on every (re)open, so an
        # EXPLICIT value — including ``None`` when the target is now projectless —
        # must overwrite the stale snapshot. Only ``_UNSET`` (no hint passed)
        # preserves it. Without the null-clearing case the tab kept its old
        # project color forever.
        if project_id is not _UNSET and existing.project_id != project_id:
            existing.project_id = project_id
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
        # Adopt into a group on (re)open: opening an already-open tab from inside
        # a workspace must pull it into that workspace's subset. Last-writer-wins
        # (a tab belongs to at most one group). ``None`` = no hint → preserve
        # (matches the name/icon_key hint convention). Never self-parent.
        if parent_tab_id and parent_tab_id != tid and existing.parent_tab_id != parent_tab_id:
            existing.parent_tab_id = parent_tab_id
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
        project_id=None if project_id is _UNSET else project_id,
        name=name,
        icon_key=icon_key,
        worktree=bool(worktree),
        visible=True,
        parent_tab_id=parent_tab_id if parent_tab_id and parent_tab_id != tid else None,
    )
    new_order = compute_insert_new(existing_ids, tid, after_tab_id)
    # Shift the existing rows whose index moved (reuses the reorder persister); the
    # new row isn't in ``by_id`` so it's set + saved once here, covering append (its
    # index never "changed" from 0) and insert alike.
    tab.tab_order = new_order.index(tid)
    await _persist_global_order(new_order, {t.id: t for t in visible})
    await tab.save()
    return tab


async def _tabs_for_target(target_type: str, target_id: str) -> list["Tab"]:
    """All Tabs denormalized onto a target entity (the reverse lookup shared by
    every target-driven tab maintenance hook). Best-effort: returns [] if the Tab
    type is absent (e.g. a pytest env without ``register_all``), so callers never
    have to guard the query themselves."""
    try:
        return await Tab.get_all({"target_type": target_type, "target_id": str(target_id)})
    except Exception:
        return []


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
    hid = False
    for tab in await _tabs_for_target(target_type, target_id):
        if getattr(tab, "visible", False):
            tab.visible = False
            await tab.save()
            hid = True
    if hid:
        # Background death (worker stop / orphan cleanup) — ping clients to refetch
        # so the chip drops without waiting for the next navigation.
        await broadcast_tabs_changed()


async def reconcile_tab_project(target_type: str, target_id: str, project_id: str | None) -> int:
    """Re-derive the denormalized ``project_id`` of every Tab pointing at a target
    entity after that entity's project changes, and ping clients. Returns the
    number of tabs updated.

    ``tab.project_id`` is a snapshot of the target's project taken at tab
    creation; nothing else re-derives it, so a (re)assignment — e.g. a
    conversation moved into a project — would otherwise leave the tab rendering
    its stale project color ("stays blue"). This is the project-change sibling of
    the orphan-close hook in ``Entity.delete``; it is driven generically from
    ``Entity.save``.
    """
    changed = 0
    for tab in await _tabs_for_target(target_type, target_id):
        if tab.project_id != project_id:
            tab.project_id = project_id
            await tab.save()
            changed += 1
    if changed:
        await broadcast_tabs_changed()
    return changed


# ── Backend-owned tab list (the single render source) ──────────────────────────
#
# The frontend strip no longer derives order or overlays live entity state from a
# reactive query: it renders exactly the rows this module returns. So every list
# row is fully resolved here (label + display primitives + live status), already
# in global order, optionally filtered to one project's view.


async def _resolve_status(tab: Tab, target: "object" = _UNSET) -> str | None:
    """Best-effort live status for the chip (``closing`` ⇒ disabled affordance).
    Duck-typed: a Shell carries ``status``; an AgenticProcess defers to its linked
    shell (``shell_id``). Absent/unknown ⇒ ``None`` (enabled).

    Only terminal targets carry a status, so content/target-less tabs short-circuit
    BEFORE any DB read — the list path resolves no entity for the ~majority of rows
    (markdown/asset/settings/search/diff).

    ``target`` may be passed pre-loaded — the entity ``_populate_tab_statuses``
    already batch-fetched (or ``None`` when the batch didn't find it) — to skip the
    per-tab ``get_one``. ``_UNSET`` (the default, for callers without a batch) falls
    back to a direct ``_target_entity`` read."""
    if tab.target_type not in _DB_BACKED_TARGET_TYPES:
        return None
    if target is _UNSET:
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


async def _populate_tab_statuses(
    tabs: list[Tab],
    target_map: "dict[tuple[str, str], object] | None" = None,
) -> None:
    """Populate ``status`` and ``is_disabled`` on a list of Tabs (in-place).

    Resolves the backing SHELL/AGENTIC_PROCESS entities in ONE batched
    ``id IN (…)`` load per type (``_load_status_targets``) instead of a
    ``get_one`` per tab, then derives each chip's status from the pre-loaded map.
    Content/target-less tabs (markdown/asset/settings/…) carry no status and
    never touch the DB. ``target_map`` may be supplied by a caller that already
    loaded it, to avoid re-querying."""
    status_types = _DB_BACKED_TARGET_TYPES
    if target_map is None:
        target_map, _ = await _load_status_targets(tabs)
    for tab in tabs:
        if tab.target_type in status_types and tab.target_id:
            target = target_map.get((tab.target_type, str(tab.target_id)))
            tab.status = await _resolve_status(tab, target)
        else:
            tab.status = None
        tab.is_disabled = tab.status == "closing"


async def _project_from_pointer(pointer: str | None) -> str | None:
    """The owning project NAMED by a project-scoped dock pointer
    (``viewType:"project"`` → ``<project_id>/...``). A tab opened under
    ``/dock/project/<id>/...`` belongs to that project even when its target row is
    missing/unindexed (an editor on a not-yet-indexed markdown) — the URL itself
    is the authority. Returns the id only when it's a valid entity id AND the
    project still exists, so a stale pointer to a deleted project never stamps a
    dangling id."""
    if not pointer:
        return None
    try:
        data = _json.loads(pointer)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or data.get("viewType") != "project":
        return None
    candidate = str(data.get("pointer") or "").split("/", 1)[0].strip()
    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

    if not is_valid_entity_id(candidate):
        return None
    return candidate if await _project_exists(candidate) else None


async def _backfill_tab_projects(tabs: list[Tab]) -> None:
    """Backfill a null ``project_id`` server-side, so the chip renders
    project-colored even for a row the FE re-shows WITHOUT re-minting — an
    existing tab persisted projectless before its project was resolvable (an
    unindexed claude-session lens, an editor on an unindexed markdown), or minted
    by an older client. The list is the single source the strip draws from, so
    resolving here heals every chip on plain navigation, no ``new_tab`` re-mint
    needed.

    Resolution is IN-MEMORY ONLY — this is a read path (GET ``list``/``list_all``),
    so it no longer writes (the old per-row ``tab.save()`` heated the SQLite writer
    on every list fetch). The assignment is enough for both the response and the
    project filter (``_build_tab_list`` reads ``tab.project_id`` straight after);
    durable persistence of the heal moves to the next ``ensure_tab``/open of the
    same pointer.

    Resolution order: the target entity's own project (authoritative — includes
    the claude-session on-disk recovery), else the project a project-scoped dock
    URL itself declares (``/dock/project/<id>/...``)."""
    for tab in tabs:
        if tab.project_id:
            continue
        resolved: str | None = None
        if tab.target_type and tab.target_id:
            resolved = await _project_of_target(tab.target_type, tab.target_id)
        if not resolved:
            resolved = await _project_from_pointer(tab.pointer)
        if not resolved:
            continue
        tab.project_id = resolved


async def _build_tab_list(project: str | None) -> list[Tab]:
    """The ordered, project-filtered list of Tabs with runtime status resolved.
    Global order filtered to ``{project OR projectless}`` (decision 3), each Tab
    fully populated with status/is_disabled. The Tab objects are serialized
    directly for API responses — no separate projection."""
    tabs, target_map = await _visible_tabs_sorted_with_targets()
    # Heal projectless chips BEFORE filtering, so a backfilled tab routes to its
    # real project's view rather than staying in the projectless bucket.
    await _backfill_tab_projects(tabs)
    order_ids = [t.id for t in tabs]
    project_of: dict[str, str | None] = {t.id: t.project_id for t in tabs}
    filtered = filter_for_project(order_ids, project_of, _normalize_project(project))
    by_id = {t.id: t for t in tabs}
    result = [by_id[tab_id] for tab_id in filtered]
    await _populate_tab_statuses(result, target_map)
    return result


def _serialize_row(tab: Tab) -> dict:
    """Serialize the strip-facing Tab projection without base Entity computed fields."""
    return {
        "id": tab.id,
        "type": tab.type,
        "pointer": tab.pointer,
        "target_type": tab.target_type,
        "target_id": tab.target_id,
        "parent_tab_id": tab.parent_tab_id,
        "project_id": tab.project_id,
        "name": tab.name,
        "icon_key": tab.icon_key,
        "worktree": tab.worktree,
        "tab_order": tab.tab_order,
        "last_active_at": tab.last_active_at,
        "visible": tab.visible,
        "status": tab.status,
        "is_disabled": tab.is_disabled,
    }


async def _build_list(project: str | None) -> list[dict]:
    """Compatibility projection for older tests/callers.

    The canonical implementation returns ``Tab`` objects via ``_build_tab_list``;
    this helper preserves the previous dict-row contract without introducing a
    second ordering or filtering path.
    """
    tabs = await _build_tab_list(project)
    return [_serialize_row(t) for t in tabs]


# Stable sentinel TypeId for the global ping. ``flow_data_msg`` is dropped client-
# Broadcast signal moved to proper broadcast() function in websocket.py
# (was: creating synthetic tab ID = uuid5(__tabs_changed_signal__), which was horrible design)


async def broadcast_tabs_changed() -> None:
    """Global ``tabs-changed`` ping so every client refetches the list — covers
    backend-originated changes (death/orphan-cleanup, rename, second window). Sends
    a proper broadcast message to all connected clients."""
    try:
        from flow_sdk.server.routes.websocket import broadcast  # noqa: PLC0415
        from pydantic import BaseModel
        from flow_sdk.api.messages import WSMessageType

        class TabsChangedMessage(BaseModel):
            message_type: str = WSMessageType.BROADCAST.value
            broadcast_type: str = "tabs_changed"

        await broadcast(TabsChangedMessage().model_dump_json())
    except Exception as e:
        logger.debug(f"broadcast_tabs_changed failed: {e}")


async def _list_response(project: str | None):
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    tabs = await _build_tab_list(project)
    return ApiSuccessResponse(data={"tabs": [_serialize_row(t) for t in tabs]})


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
    parent_tab_id: str | None = None,
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
        parent_tab_id=parent_tab_id,
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

    tabs, target_map = await _visible_tabs_sorted_with_targets()
    await _backfill_tab_projects(tabs)
    await _populate_tab_statuses(tabs, target_map)
    return ApiSuccessResponse(data={"tabs": [_serialize_row(t) for t in tabs]})


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
