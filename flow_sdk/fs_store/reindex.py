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


def _mint_candidates(path: str) -> tuple[str, ...]:
    return _EXT_MINT_CANDIDATES.get(Path(path).suffix.lower(), ())


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
        return await discover_record_by_path(
            entity.type, target, notify=True, proposed_id=str(entity_id) if entity_id else None
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
            for cand in _mint_candidates(path):
                try:
                    if await discover_record_by_path(cand, path, notify=True, strict_owner=True) is not None:
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

            # Inner file removed from a still-present folder asset → resync folder.
            folder = await Entity.get_by_asset_ref(path, resolve_containing=True, strict=True)
            if folder is not None:
                await _resync(folder, path)
                result.reindexed.append(path)
            else:
                result.skipped.append(path)
        except Exception as exc:  # noqa: BLE001
            logger.debug("reindex_paths(delete): %s failed: %s", path, exc)
            result.skipped.append(path)

    return result
