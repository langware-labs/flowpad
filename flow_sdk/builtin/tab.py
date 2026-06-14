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

import uuid

from flow_sdk.actions.action_registry import action as _action_registry
from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.core import Entity
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.schema.types import EntityType


def tab_id_for(pointer: str) -> str:
    """Deterministic Tab id (uuid5) for a canonical pointer string.

    The ``tab:`` scheme prefix keeps the Tab keyspace disjoint from every other
    ``mint_uuid`` caller that uses ``NAMESPACE_URL``.
    """
    return mint_uuid(key=f"tab:{pointer}", namespace=uuid.NAMESPACE_URL)


class Tab(Entity):
    type: str = APIField(default=EntityType.TAB.value)

    # Canonical serialized DockPointer (frontend ``DockPointer.tabHash``). The
    # natural key — Tab.id == uuid5("tab:"+pointer). Opaque to the backend.
    pointer: str = APIField(default="")
    # Denormalized target identity, derived from the pointer by the caller for
    # fast reverse lookup. Null for target-less surfaces (settings/search/diff).
    target_type: str | None = APIField(default=None)
    target_id: str | None = APIField(default=None)

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

    # ``name`` and ``project_id`` are inherited from the base Entity. ``name`` is
    # the generic source of truth for the tab label; entities MAY subscribe to
    # the ``tab-renamed`` event to reflect it onto themselves (shell/AP).
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

    async def rename(self, name: str) -> None:
        """``Tab.name`` is the generic source of truth for the tab label. Set it,
        then reflect onto the target entity via the ``tab-renamed`` event — any
        entity that ``on_event("tab-renamed")`` (shell/agentic_process today)
        mirrors the new name onto itself (and the FE sends the PTY ``/rename``).
        Entities that don't subscribe simply keep the label on the Tab.
        """
        self.name = name
        await self.save()
        target = await self._target_entity()
        if target is not None:
            await target.entity_event(event="tab-renamed", payload={"name": name})

    async def _target_entity(self):
        if not (self.target_type and self.target_id):
            return None
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        entity_cls = SchemaRegistry.get_entity_cls(self.target_type)
        if entity_cls is None:
            return None
        return await entity_cls.get_one({"id": self.target_id})


async def ensure_tab(
    pointer: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    project_id: str | None = None,
    name: str | None = None,
) -> Tab:
    """Deterministic get-or-create for a tab, keyed by the canonical pointer.

    On reopen (same pointer) the existing row is reused and re-shown
    (``visible=True``); the denormalized target/project/name hints are refreshed
    but identity never changes. Models ``ensure_file_entity``.
    """
    tid = tab_id_for(pointer)
    existing = await Tab.get_one({"id": tid})
    if existing is not None:
        dirty = False
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
        # ``name`` is a CREATE-only initial label — never overwrite an existing
        # row's name on reuse, so a user rename survives re-open.
        if dirty:
            await existing.save()
        return existing
    tab = Tab(
        id=tid,
        pointer=pointer,
        target_type=target_type,
        target_id=target_id,
        project_id=project_id,
        name=name,
        visible=True,
    )
    await tab.save()
    return tab


async def _http_close(self: Tab):
    """HTTP wrapper for ``Tab.close`` — POST /graph/tab/<id>/close. Keeps the
    method itself a clean, console-testable ``async`` returning None."""
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    await self.close()
    return ApiSuccessResponse(data={"id": self.id, "visible": self.visible})


_action_registry.register(
    action_name="close",
    function_name="close",
    handler=_http_close,
    methods="post",
    types=["tab"],
)


async def _http_rename(self: Tab):
    """HTTP wrapper for ``Tab.rename`` — POST /graph/tab/<id>/rename {name}."""
    from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    request_info = get_current_request_info()
    body = (await request_info.get_post_data() if request_info is not None else {}) or {}
    name = body.get("name") or ""
    await self.rename(name)
    return ApiSuccessResponse(data={"id": self.id, "name": self.name})


_action_registry.register(
    action_name="rename",
    function_name="rename",
    handler=_http_rename,
    methods="post",
    types=["tab"],
)
