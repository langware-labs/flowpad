"""Force-reindex a set of changed files → entities, then broadcast.

The push side of the ``file change → reindex → entity change → refresh`` loop.
Given a list of paths a writer just touched (an agentic-process turn, an
external editor, a client's ``POST /fs-records/invalidate``), this resolves
each to its owning entity, **re-parses the source from disk**, and syncs with
``notify=True`` so a ``data_op_msg`` (bumped ``updated_date``) reaches watching
clients — which is what drives the frontend's body re-read.

Key correctness points:
- Resolution is containment-aware: a file INSIDE a folder-backed asset (a file
  under a skill folder) resolves to the owning folder entity, and the re-parse
  runs on the *folder's* asset_ref — never the raw inner path (which
  ``extract_skill`` would mis-name).
- The re-parse goes through ``discover_record_by_path(..., notify=True)`` rather
  than ``get_record()+sync_to_db()``: the shadow ``metadata.json`` holds STALE
  ``body``/``content``, so only a fresh ``from_disk_fn`` parse reflects the new
  bytes in FTS/wiki/entity fields.
- Best-effort per path: one bad path never sinks the batch.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

# New-file mint inference. A brand-new file with no owning entity is minted only
# for types whose discovery unambiguously matches by extension — never guessed,
# to avoid minting the wrong type (e.g. a folder-asset sentinel as a markdown).
# Editing an EXISTING file never hits this path (it resolves via its entity).
_EXT_MINT_CANDIDATES: dict[str, tuple[str, ...]] = {
    ".md": ("markdown",),
    ".csv": ("spreadsheet",),
    ".xlsx": ("spreadsheet",),
}


async def owning_asset_for_removed_path(path: str):
    """``(row, root_gone)`` for a path a source reports as gone.

    THE removal policy, in one place, because two callers need it and they must
    not drift: ``reindex_paths``'s removal loop and ``reflect._retire_row``.

    Exact match first, then containment — a folder-layout asset is named by its
    ROOT, so an inner file's path never matches it exactly and an exact-only
    lookup silently finds nothing and leaves a zombie row. ``root_gone`` is then
    decided on the ROW'S OWN ``asset_ref``, never on the touched path: deleting
    ONE file inside a folder asset must not reap the asset, and only the root
    answers that. ``source_unreachable`` keeps the existing policy that an
    unreadable volume is not a deletion.
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import source_unreachable  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import LayoutKind, SchemaRegistry  # noqa: PLC0415

    row = await Entity.get_by_asset_ref(path, resolve_containing=False, strict=True)
    if row is None:
        row = await Entity.get_by_asset_ref(path, resolve_containing=True, strict=True)
    if row is None:
        return None, False
    root = str(getattr(row, "asset_ref", "") or "")
    if not root:
        return row, False
    # "Still there?" is the TYPE's question, not a bare stat: removing a folder
    # asset's main_file leaves the directory behind, and an ``exists()`` on that
    # empty shell reports a live asset that has no content. ``layout_of(verify)``
    # is the registry's own answer — it requires the main_file for a folder type.
    info = SchemaRegistry.get(row.get_type())
    alive = (
        info.layout_of(Path(root), verify=True).kind is not LayoutKind.NONE
        if info is not None
        else Path(root).exists()
    )
    return row, (not alive and not source_unreachable(root))


def asset_target_for(record_type: str, path: str) -> str:
    """The path ``discover_record_by_path`` must be handed for ``record_type``.

    A folder-layout asset's root is its DIRECTORY; handed the inner ``main_file``
    it resolves nothing and returns None, and the caller silently loses the
    re-parse. The registry already answers this (``TypeInfo.layout_of().ref``),
    so ask it instead of passing the raw touched path through.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(record_type)
    if info is None:
        return path
    ref = info.layout_of(Path(path)).ref
    return str(ref) if ref is not None else path


@dataclass
class ReindexResult:
    reindexed: list[str] = field(default_factory=list)
    minted: list[str] = field(default_factory=list)
    orphaned: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["counts"] = {k: len(v) for k, v in d.items()}
        return d


def _norm(p: str) -> str:
    return str(Path(p).expanduser())


def _mint_candidates(path: str) -> tuple[tuple[str, str], ...]:
    """``(type, target path)`` pairs to try, most specific first.

    A folder-layout type names its carrier with a FIXED ``main_file``
    (``SKILL.md``), so a name match identifies the type unambiguously — exactly
    the property the extension map lacks and the reason it stays restricted. Ask
    the registry's own classifier (``TypeInfo.layout_of``) rather than guessing
    from the suffix, and hand back the layout's ``ref``: a folder asset's root is
    its DIRECTORY, and ``discover_record_by_path`` cannot mint one from the inner
    file path. Without this the incremental path mints ``SKILL.md`` as a plain
    markdown whose asset_ref is the FILE, and every sibling written into that
    folder then fails to resolve to an owner and fragments into its own entity.
    """
    from flow_sdk.fs_store.schema_registry import LayoutKind, SchemaRegistry  # noqa: PLC0415

    p = Path(path)
    out: list[tuple[str, str]] = []
    for type_name in SchemaRegistry.get_all_types():
        info = SchemaRegistry.get(type_name)
        if info is None or info.main_layout != "folder" or not info.main_file:
            continue
        layout = info.layout_of(p, verify=True)
        if layout.kind is LayoutKind.NONE or layout.ref is None:
            continue
        out.append((type_name, str(layout.ref)))
    out.extend((cand, path) for cand in _EXT_MINT_CANDIDATES.get(p.suffix.lower(), ()))
    return tuple(out)


async def reindex_paths(
    paths: Iterable[str],
    deleted_paths: Iterable[str] = (),
    *,
    mint: bool = True,
) -> ReindexResult:
    """Force-reindex ``paths`` (changed/created) and reconcile ``deleted_paths``.

    Returns a :class:`ReindexResult` with the per-bucket path lists. Each path
    is handled independently; failures are logged and counted as ``skipped``.

    ``mint=False`` makes this resolution-only: a path with no owning entity is
    left alone instead of minting one. Callers that resync a file a user just
    wrote (``fs/write``) must pass it — minting there stamps an identity capsule
    INTO the bytes the caller just saved, mutating arbitrary markdown that was
    never an asset. New-file discovery belongs to the indexer, which owns root
    scoping and consent.
    """
    from flow_sdk.builtin.faas.fs_records_actions import discover_record_by_path  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import source_unreachable  # noqa: PLC0415
    from flow_sdk.fs_store.orphan_removal import remove_orphan_row  # noqa: PLC0415

    result = ReindexResult()

    # Force-reparse an entity's OWN asset_ref (folder path for folder types), not
    # the raw touched path — extract_skill et al. would mis-name a raw inner path.
    async def _resync(entity, fallback: str):
        target = str(getattr(entity, "asset_ref", None) or fallback)
        # Thread the already-resolved entity id so a portable asset whose in-file
        # identity capsule was wiped by a full-content overwrite re-stamps the
        # ORIGINAL id (same entity updates) instead of forking a fresh v4. Only
        # consulted on a capsule miss; folder/carrier-intact types ignore it.
        entity_id = getattr(entity, "id", None)
        # Thread the row's OWN scope/project_id too. Without them
        # ``discover_record_by_path`` falls back to ``classify_path(path)``, which
        # knows only three roots (system / user_home / cwd) and calls anything under
        # the user's home ``user`` — so resyncing an asset in a project stored at
        # ``~/Flowpad workspace/<proj>`` relabels it ``scope='user'`` and
        # ``apply_scope_filter`` then hides it from its own project. This is a
        # resync of an entity we ALREADY resolved: its stored labels are
        # authoritative and a path guess must not overwrite them.
        return await discover_record_by_path(
            entity.type,
            target,
            notify=True,
            proposed_id=str(entity_id) if entity_id else None,
            scope=entity.scope,
            project_id=entity.project_id,
        )

    # De-dupe while preserving order.
    changed = list(dict.fromkeys(_norm(x) for x in paths))
    removed = list(dict.fromkeys(_norm(x) for x in deleted_paths))

    for path in changed:
        try:
            entity = await Entity.get_by_asset_ref(path, resolve_containing=True, strict=True)
            if entity is not None:
                found = await _resync(entity, path)
                (result.reindexed if found is not None else result.skipped).append(path)
                continue

            # No owning entity — attempt a type-inferred mint (new file).
            if not mint:
                result.skipped.append(path)
                continue
            minted = False
            for cand, target in _mint_candidates(path):
                try:
                    if await discover_record_by_path(cand, target, notify=True, strict_owner=True) is not None:
                        result.minted.append(path)
                        minted = True
                        break
                except Exception as exc:  # noqa: BLE001
                    logger.debug("reindex mint %s as %s failed: %s", path, cand, exc)
            if not minted:
                result.skipped.append(path)
        except Exception as exc:  # noqa: BLE001
            logger.debug("reindex_paths: %s failed: %s", path, exc)
            result.skipped.append(path)

    for path in removed:
        try:
            exact = await Entity.get_by_asset_ref(path, resolve_containing=False, strict=True)
            if exact is not None:
                rec = await exact.get_record()
                if rec is not None and rec.orphan:
                    await remove_orphan_row(str(exact.id), exact.get_type())
                    result.orphaned.append(path)
                elif rec is not None and source_unreachable(path):
                    # `rec.orphan` already declined; without this we would fall
                    # through to a resync on the same unreadable path.
                    result.skipped.append(path)
                else:
                    # Source still present (shouldn't be in deleted) — resync.
                    await _resync(exact, path)
                    result.reindexed.append(path)
                continue

            # A file removed from inside a folder asset. Which of the two cases it
            # is depends on the asset ROOT, not on the touched path: the root is
            # what the row names now that folder types are typed correctly, and an
            # exact-match lookup on an inner path can no longer find it.
            folder = await Entity.get_by_asset_ref(path, resolve_containing=True, strict=True)
            if folder is not None:
                root = str(getattr(folder, "asset_ref", "") or "")
                if root and not Path(root).exists() and not source_unreachable(root):
                    # The whole asset is gone — reap it, or deleting a skill would
                    # leave a row pointing at nothing, searchable forever.
                    await remove_orphan_row(str(folder.id), folder.get_type())
                    result.orphaned.append(path)
                else:
                    # Root still there: ONE inner file went away. Never reap on
                    # this branch — that asymmetry is load-bearing.
                    await _resync(folder, path)
                    result.reindexed.append(path)
            else:
                result.skipped.append(path)
        except Exception as exc:  # noqa: BLE001
            logger.debug("reindex_paths(delete): %s failed: %s", path, exc)
            result.skipped.append(path)

    return result
