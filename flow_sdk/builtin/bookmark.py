import logging
from flow_sdk._compat import StrEnum
from typing import Any, ClassVar, Dict, Optional

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
    way. A shared favorite is unscoped (the receiver's Bookmark has no project
    column) — it shows in the bookmarks slider regardless of the active project.

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
