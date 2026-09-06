import asyncio
import logging
from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Dict, NamedTuple, Optional

from flow_sdk.actions.action_registry import action as _action_registry
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity

logger = logging.getLogger(__name__)


class BookmarkStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    PENDING = "pending"


class BookmarkType(StrEnum):
    NOTE = "note"
    CONTEXT = "context"
    SUMMARY = "summary"
    NOTIFICATION = "notification"
    NOTIFICATION_FAILED = "notification_failed"
    TERMINAL_ANNOTATION = "terminal_annotation"
    FAVORITE = "favorite"
    FAVORITE_FOLDER = "favorite_folder"
    PLAN = "plan"


async def _promote_folder_children(folder_id: str) -> None:
    """Null ``parent_id`` on every bookmark filed under a deleted favorite
    folder — deleting a grouping must never delete (or strand) its members.
    Best-effort per child, mirroring tab.py's ``_clear_parent_refs``."""
    try:
        children = await Bookmark.get_all({"parent_id": folder_id})
    except Exception:
        return
    for child in children:
        child.parent_id = ""
        try:
            await child.save()
        except Exception:
            continue


class Bookmark(Entity):
    type: str = APIField(default="bookmark")
    bookmark_type: str = APIField("")
    source: str = APIField("")
    title: str = APIField("")
    content: str = APIField("")
    data: Optional[Dict[str, Any]] = APIField(default_factory=dict)
    session_id: str = APIField("")
    work_dir: str = APIField("")
    status: str = APIField(BookmarkStatus.OPEN)
    closed_at: Optional[str] = APIField(None)
    remind_at: Optional[str] = APIField(None)
    # Grouping edge to a containing FAVORITE_FOLDER bookmark ("" = root).
    # Same parent-pointer idea as Tab.parent_tab_id, but deliberately an empty
    # string rather than Tab's Optional[None]: API responses drop None fields
    # and the frontend store merge never removes keys, so un-filing could not
    # propagate as None. Folder deletion promotes children to root.
    parent_id: str = APIField("")
    # Manual placement within the parent container (desktop grid). 0 =
    # unstamped (sorts at the END of a stamped container, newest first);
    # stamped values are contiguous from 1 — see `sort_container` and the
    # `bookmark.order` action. DB-only (bookmark has no meta_model), matching
    # every other custom bookmark field.
    order: int = APIField(0)
    # Times this favorite has been opened. 0 — including absent, on every row
    # written before this field existed — means "never opened", which is what
    # the desktop's unread badges count. DB-only, like `order`.
    counter: int = APIField(0)
    # Looked at without being opened — a rest of the pointer on the row in the
    # favorites menu. Clears the unread badge alongside `counter`, but stays a
    # separate flag so a hover never inflates the open count. DB-only, like
    # `order`.
    seen: bool = APIField(False)

    @property
    def display_name(self) -> str:
        body = self.content
        if body:
            first_line = str(body).strip().splitlines()[0][:100]
            if first_line:
                return first_line
        if self.title:
            return self.title.strip()
        return self.name or ""

    async def delete(self):
        if self.bookmark_type == BookmarkType.FAVORITE_FOLDER and self.id:
            await _promote_folder_children(str(self.id))
        return await super().delete()

    @classmethod
    async def delete_by_id(cls, eid: str):
        # The HTTP delete path (handle_delete_by_id) bypasses the instance
        # delete(), so child promotion must fire here too — same reason
        # EntityModel.delete_by_id does its orphan-Tab cleanup.
        try:
            bm = await cls.get_by_id(eid)
        except Exception:
            bm = None
        if bm is not None and bm.bookmark_type == BookmarkType.FAVORITE_FOLDER:
            await _promote_folder_children(str(eid))
        return await super().delete_by_id(eid)


async def mint_share_favorite(
    *,
    owner,
    entity_type: str,
    entity_id: str,
    title: str,
    asset_ref: str = "",
    icon: Optional[str] = None,
    source: str = "shared",
) -> "Bookmark | None":
    """Create a FAVORITE bookmark for ``owner`` pointing at a just-installed
    entity (the "create bookmark" share opt-in). Idempotent: a favorite already
    pointing at ``(entity_type, entity_id)`` is left as-is. ``data`` shape matches
    the frontend ``addFavorite`` + the onboarding favorite in
    ``server/routes/bootstrap.py`` so every favorite surface resolves it the same
    way. A shared favorite is deliberately left unscoped — unlike a ``flow show``,
    which by definition happened inside a project, a received asset installs to
    USER scope, so a global favorite matches where the asset actually lands. It
    shows in the bookmarks slider regardless of the active project.

    ``asset_ref`` may be "" for a git-backed artifact whose checkout isn't
    resolved yet — the favorite navigates by ``(entity_type, entity_id)`` and
    the artifact-open path materializes the checkout on click.
    """
    if not entity_type or not entity_id:
        return None
    try:
        existing = await Bookmark.get_all({"bookmark_type": BookmarkType.FAVORITE.value}, source_entity=owner)
    except Exception:
        existing = []
    for b in existing:
        data = b.data or {}
        if data.get("entity_type") == entity_type and data.get("entity_id") == entity_id:
            return b
    fav = Bookmark(
        bookmark_type=BookmarkType.FAVORITE.value,
        title=title or entity_id,
        source=source,
        data={
            "entity_type": entity_type,
            "entity_id": entity_id,
            "icon": icon,
            "nav": {"asset_ref": asset_ref or ""},
        },
    )
    try:
        await fav.save(owner)
    except Exception:
        logger.warning("[bookmark] mint_share_favorite failed for %s-@%s", entity_type, entity_id, exc_info=True)
        return None
    return fav


_FAVORITE_TYPES = {BookmarkType.FAVORITE.value, BookmarkType.FAVORITE_FOLDER.value}

# ── Auto-bookmark: every `flow show` files its target into a nested favorites tree
#    Auto / <type> / <item>. The tree is machine-built (source="auto"); leaves and
#    both folder levels are found-or-created idempotently so repeated shows never
#    duplicate. A new leaf is a CREATE op → the bookmarks query notifies watchers →
#    the folder count badges tick live (see ui/src/hooks/use-favorites.ts).
AUTO_ROOT_TITLE = "Auto"
AUTO_SOURCE = "auto"
# Folder labels for the non-entity display kinds (entity kinds get theirs from
# TypeInfo.display_name). One source of truth, keyed by bucket.
_AUTO_KIND_LABELS = {"file": "Files", "webapp": "Web Apps"}


class _AutoTarget(NamedTuple):
    """One classification of a resolved display target — everything the auto tree
    needs, so the ``kind`` discriminant is switched exactly once."""

    bucket: str        # subfolder key (data.auto_type) + which type-folder it lands in
    label: str         # subfolder display title
    entity_type: str   # nav-identity type (may differ from bucket: a file bucket navs as "vfs")
    entity_id: str     # dedup key together with entity_type
    asset_ref: str
    extra: dict


def _auto_classify(payload: Dict[str, Any]) -> _AutoTarget:
    """Classify a resolved display target once. Entity → its type + curated
    ``TypeInfo.display_name``; raw file → "Files" (nav by path); webapp → "Web Apps"
    (nav by port)."""
    kind = payload.get("kind")
    if kind == "entity":
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        t = str(payload.get("type") or "entity")
        return _AutoTarget(t, SchemaRegistry.get_display_name(t), t,
                           str(payload.get("id") or ""), str(payload.get("path") or ""), {})
    if kind == "webapp":
        port = payload.get("port")
        return _AutoTarget("webapp", _AUTO_KIND_LABELS["webapp"], "webapp", str(port), "", {"port": port})
    path = str(payload.get("path") or "")
    return _AutoTarget("file", _AUTO_KIND_LABELS["file"], "vfs", path, path, {})


def _auto_nice_name_from_path(path: str) -> str:
    """A readable leaf title from a path — the parent folder name for a folder-main
    file (``…/website-traffic-dashboard/SKILL.md`` → "website-traffic-dashboard"),
    else the basename stem. The registry says which names are a folder type's
    main document (``SchemaRegistry.main_file_owners``)."""
    from pathlib import Path as _Path  # noqa: PLC0415

    p = _Path(path)
    try:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        if SchemaRegistry.main_file_owners(p):
            return p.parent.name or p.name
    except Exception:
        pass
    return p.stem or p.name


def _auto_leaf_title(payload: Dict[str, Any], target: _AutoTarget) -> str:
    """Best UX title for the leaf: the name ``resolve_display_target`` already loaded
    (no second entity fetch), else a readable path name, else a short typed fallback."""
    name = payload.get("name")
    if name:
        return str(name)
    if payload.get("kind") == "webapp":
        return f"localhost:{payload.get('port')}"
    if target.asset_ref:
        return _auto_nice_name_from_path(target.asset_ref)
    return f"{target.entity_type}-{target.entity_id[:8]}" if target.entity_id else (target.entity_type or "item")


async def mint_auto_favorite(
    *, owner, payload: Dict[str, Any], project_id: Optional[str] = None
) -> "Bookmark | None":
    """File a resolved ``flow show`` target into the ``Auto / <type> / item`` favorites
    tree (best-effort, idempotent). Returns the leaf favorite, or ``None`` when the
    payload can't be identified. All three levels are owned by ``owner`` and saved
    with ``notify=True`` so the UI ticks live.

    ``project_id`` stamps every level and keys all three find-or-create lookups, so
    project B can't adopt project A's Auto root. ``None`` (a project-less show —
    EMBEDDED/INLINE) keeps the pre-stamping unscoped row, which ``bookmarkInScope``
    shows everywhere. The eventual home for the stamp itself is the generic one in
    ``Entity._prepare_for_storage`` — it doesn't fire here because
    ``_resolve_scope_project`` only recognizes a project when the request target IS
    one, and ``flow show`` posts to the process.
    """
    target = _auto_classify(payload)
    if not target.entity_id:
        return None

    # `""` and NULL both mean "no project" in this column, so fold them or a
    # project-less show builds two parallel trees.
    pid = project_id or None

    # Scan only THIS project's auto tree (source="auto"), the two levels
    # concurrently — never the owner's manual favorites. Scoped scans filter in
    # the query; the unscoped scan has to filter in Python because `IS_NULL`
    # misses the `""` rows — the same split as `prompt_helpers.project_prompts`.
    scope_filter = {"project_id": pid} if pid else {}
    try:
        folders, leaves = await asyncio.gather(
            Bookmark.get_all(
                {"bookmark_type": BookmarkType.FAVORITE_FOLDER.value, "source": AUTO_SOURCE, **scope_filter},
                source_entity=owner,
            ),
            Bookmark.get_all(
                {"bookmark_type": BookmarkType.FAVORITE.value, "source": AUTO_SOURCE, **scope_filter},
                source_entity=owner,
            ),
        )
    except Exception:
        logger.warning("[bookmark] mint_auto_favorite scan failed", exc_info=True)
        return None

    if not pid:
        folders = [f for f in folders if not f.project_id]
        leaves = [b for b in leaves if not b.project_id]

    # 1) Auto root folder — keyed by data.auto_root.
    root = next((f for f in folders if (f.data or {}).get("auto_root")), None)
    if root is None:
        root = Bookmark(
            bookmark_type=BookmarkType.FAVORITE_FOLDER.value,
            title=AUTO_ROOT_TITLE,
            source=AUTO_SOURCE,
            project_id=pid,
            data={"auto_root": True},
        )
        await root.save(owner)

    # 2) Per-type subfolder — keyed by (parent==root, data.auto_type==bucket).
    sub = next(
        (
            f
            for f in folders
            if f.parent_id == str(root.id) and (f.data or {}).get("auto_type") == target.bucket
        ),
        None,
    )
    if sub is None:
        sub = Bookmark(
            bookmark_type=BookmarkType.FAVORITE_FOLDER.value,
            title=target.label,
            source=AUTO_SOURCE,
            parent_id=str(root.id),
            project_id=pid,
            data={"auto_type": target.bucket},
        )
        await sub.save(owner)

    # 3) Leaf — dedup by target within this project's auto tree (the query already
    #    scoped to source=="auto", so a manual star of the same entity never
    #    collides). Self-heal its parent if it drifted.
    def _matches(b: "Bookmark") -> bool:
        d = b.data or {}
        return d.get("entity_type") == target.entity_type and str(d.get("entity_id") or "") == target.entity_id

    leaf = next((b for b in leaves if _matches(b)), None)
    if leaf is not None:
        if leaf.parent_id != str(sub.id):
            leaf.parent_id = str(sub.id)
            try:
                await leaf.save(owner)
            except Exception:
                logger.warning("[bookmark] auto leaf re-file failed", exc_info=True)
        return leaf

    icon = payload.get("icon")
    if icon is None and payload.get("kind") == "entity":
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        icon = SchemaRegistry.get_icon(target.entity_type)
    leaf = Bookmark(
        bookmark_type=BookmarkType.FAVORITE.value,
        title=_auto_leaf_title(payload, target),
        source=AUTO_SOURCE,
        parent_id=str(sub.id),
        project_id=pid,
        data={
            "entity_type": target.entity_type,
            "entity_id": target.entity_id,
            "icon": icon,
            "nav": {"asset_ref": target.asset_ref},
            **target.extra,
        },
    )
    try:
        await leaf.save(owner)
    except Exception:
        logger.warning("[bookmark] mint_auto_favorite leaf save failed", exc_info=True)
        return None
    return leaf


def sort_container(siblings: "list[Bookmark]") -> "list[Bookmark]":
    """Container sort: stamped rows (order >= 1) ascending first (id ascending
    as the tiebreak), unstamped rows (order == 0) at the END, newest first
    among themselves. Mirrored byte-for-byte by ``sortContainer``
    (ui/src/lib/container-sort.ts); parity is proven by the shared matrix
    ui/tests/fixtures/container-sort-matrix.json."""
    stamped = sorted(
        (b for b in siblings if (getattr(b, "order", 0) or 0) > 0),
        key=lambda b: (b.order, str(b.id)),
    )
    unstamped = sorted(
        (b for b in siblings if not (getattr(b, "order", 0) or 0)),
        key=lambda b: str(getattr(b, "created_date", "") or ""),
        reverse=True,
    )
    return stamped + unstamped


async def _container_siblings(parent_id: str) -> "list[Bookmark]":
    """The ordered members of one desktop container: root ("") holds folders +
    unfiled favorites; a folder holds its filed favorites."""
    rows = await Bookmark.get_all({})
    siblings = [
        b
        for b in rows
        if b.bookmark_type in _FAVORITE_TYPES and (b.parent_id or "") == (parent_id or "")
    ]
    return sort_container(siblings)


async def _persist_sibling_order(new_order: "list[str]", by_id: "dict[str, Bookmark]") -> bool:
    """Stamp ``order = index + 1`` (1-based — 0 is the unstamped sentinel),
    saving only rows whose value changed. Mirrors tab.py's
    ``_persist_global_order``."""
    wrote = False
    for idx, bid in enumerate(new_order):
        bm = by_id.get(bid)
        target = idx + 1
        if bm is not None and (getattr(bm, "order", 0) or 0) != target:
            bm.order = target
            await bm.save()
            wrote = True
    return wrote


# Registered as "bookmark.order" — the decorator auto-prefixes single-type
# actions with their entity type, so this coexists with tab's bare "order"
# (get_by_name tries "<type>.<name>" first).
@_action_registry.post("order", types=["bookmark"])
async def _http_order(
    cls,
    reorder_bookmark_id: str,
    after_bookmark_id: str | None = None,
    before_bookmark_id: str | None = None,
    parent_id: str = "",
):
    """POST /graph/bookmark/order — desktop drag-drop commit. Splices the
    dragged bookmark into the drop-gap within its container's order (root or a
    folder, per ``parent_id``), persisting only changed rows. Reuses the pure
    tab-order algebra (generic over id lists)."""
    from flow_sdk.builtin.tab_order import compute_reorder  # noqa: PLC0415
    from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

    siblings = await _container_siblings(parent_id)
    by_id = {str(b.id): b for b in siblings}
    if reorder_bookmark_id in by_id:
        order_ids = [str(b.id) for b in siblings]
        new_order = compute_reorder(order_ids, reorder_bookmark_id, after_bookmark_id, before_bookmark_id)
        await _persist_sibling_order(new_order, by_id)
        # The persist mutated these instances in place — re-sorting in memory
        # IS the fresh container view; no second fetch needed.
        siblings = sort_container(siblings)
    return ApiSuccessResponse(data={"bookmarks": [b.model_dump(mode="json") for b in siblings]})
