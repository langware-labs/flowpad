"""Reflection — WHERE a source's assets land locally, and nothing else.

``ingest_items`` is the single chokepoint for ``SourceItem`` writes and stays
that way. Reflection is the OTHER destination: a driver whose payload is a file
hands its asset roots here, and this module decides where those roots live on
disk before the ordinary filesystem indexer types them.

**A mode answers exactly one question:** given an asset root the driver found,
what path should the indexer be told about? It never writes an entity, never
touches FTS, and never learns which provider produced the ref. That is the
boundary — and it is asserted directly, not just documented, because a mode
that quietly minted a row would still make every functional test pass.

**Every mode ends at ``reindex_paths``.** Not at the walker, not at
``fts_upsert``. One exit means the incremental path, the skip-fresh sentinel and
the mint policy are shared by all three rather than re-derived per mode.

**The unit of reflection is the asset ROOT**, in the sense ``FSOrigin.rel_path``
already carries: a FOLDER for folder-layout types (a skill, whose ``main_file``
is ``SKILL.md``), a FILE for file-layout ones (a doc). Reusing that notion is
what keeps ``copy`` from having to special-case every type.
"""
from __future__ import annotations

import logging
import shutil
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Protocol

from flow_sdk._compat import StrEnum

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_source import DataSource

logger = logging.getLogger(__name__)


class ReflectMode(StrEnum):
    """How a source's payload becomes locally present.

    ``RECORD`` is the default and is NOT a filesystem mode — it is the existing
    ``ingest_items`` path every shipped driver already takes. It lives in this
    enum because the choice is genuinely one axis: a source lands its payload in
    the graph as a record, or on disk as an asset. Splitting it across two
    settings would let a source ask for both and get neither.
    """

    #: The graph. `ingest_items` → SourceItem. Today's behaviour for rss,
    #: hackernews, slack, agent, agentmail, cloud_email.
    RECORD = "record"
    #: The source's own directory is the walk root; nothing is duplicated.
    #: The mount-not-copy case.
    NONE = "none"
    #: Bytes duplicated into the project.
    COPY = "copy"
    #: Linked into the project instead of duplicated. NOTE: `gitignore_walk`
    #: never follows symlinked DIRECTORIES, so this cannot work for a
    #: folder-layout asset — only for a file-layout one.
    SYMLINK = "symlink"

    # ── git-native delivery ──────────────────────────────────────────────
    #
    # Named for what git actually does rather than reusing the folder names.
    # The receiving project and the asset repository are not necessarily the
    # same repo, and that distinction lives HERE rather than in a separate
    # axis: `IN_PLACE` means one repo, the other two mean two.

    #: The asset repository IS the project. Index the checkout where it sits.
    IN_PLACE = "in-place"
    #: Clone/refresh the asset repo into a local cache the project references.
    #: The true mount case — bytes arrive, but into our space, not the user's.
    MATERIALIZE = "materialize"
    #: Copy changed files into the RECEIVING repo's tracked tree. They become
    #: content under its version control, which is a real commitment: they will
    #: be committed and pushed like anything else the user wrote.
    VENDOR = "vendor"


@dataclass
class ReflectReport:
    """What reflection did, before the indexer was told anything."""

    placed: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


class Reflector(Protocol):
    """One placement policy. Holds no state and reaches no subsystem."""

    def place(self, source: "DataSource", ref: str) -> Optional[str]:
        """The local path the indexer should be told about, or None to skip."""
        ...

    def unplace(self, source: "DataSource", ref: str) -> Optional[str]:
        """The local path that should now be treated as gone, or None."""
        ...


def source_root(source: "DataSource") -> Optional[Path]:
    """Where the source's own tree begins — the DRIVER decides.

    Reflection needs it to preserve relative structure: a folder-layout asset
    copied without its parent directories is no longer that asset, just its
    inner files scattered flat.

    Delegated rather than read from a config key, because the key differs per
    provider (`root` for a folder, `repo` for a repository) and a branch on
    config keys here is exactly the provider knowledge the driver registry
    exists to keep out of this module.
    """
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    resolver = getattr(get_driver(source.provider), "source_root", None)
    if not callable(resolver):
        return None
    try:
        return resolver(source)
    except Exception:  # noqa: BLE001
        logger.debug("[reflect] source_root failed for %s", source.id, exc_info=True)
        return None


def _remove(path: Path) -> None:
    """Delete a placed asset root, whatever shape it is.

    `is_symlink` first and deliberately: a link to a directory answers True to
    `is_dir`, and `rmtree` would then delete the TARGET — the user's own tree.
    """
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _target_root(source: "DataSource") -> Optional[Path]:
    """The project directory reflected assets land under.

    Explicit on the source rather than inferred from request context: a
    ``DataSource`` is instance-global and the heartbeat tick that polls it has
    no request to resolve a project from — the trap ``data_source.py`` documents
    for scope resolution, arriving here for the same reason.
    """
    base = (source.reflect_into or "").strip()
    if not base:
        return None
    return Path(base).expanduser()


class InPlaceReflector:
    """``none`` — the source's own tree IS the indexed tree."""


    def place(self, source: "DataSource", ref: str) -> Optional[str]:
        return ref

    def unplace(self, source: "DataSource", ref: str) -> Optional[str]:
        return ref


class _ProjectionReflector:
    """Shared body for the two modes that put something in the project.

    They differ by one call — ``shutil.copytree``/``copy2`` versus
    ``Path.symlink_to`` — so the placement arithmetic, the traversal guard and
    the replace-existing rule live here once.
    """


    def _dest(self, source: "DataSource", ref: str) -> Optional[Path]:
        root = _target_root(source)
        if root is None:
            return None
        src = Path(ref)
        base = source_root(source)
        try:
            rel = src.relative_to(base) if base else Path(src.name)
        except (ValueError, TypeError):
            rel = Path(src.name)
        dest = root / rel
        # Path-traversal guard: a source-controlled ref must not escape the
        # project it is being reflected into.
        #
        # Resolve the PARENT, never the leaf. `Path.resolve()` follows symlinks,
        # and the leaf here is frequently a link we placed ourselves — so
        # resolving it answers "where does this point", not "where does this
        # live". On a dangling link (the target was deleted, which is exactly
        # when `unplace` runs) it resolves to the vanished target, lands outside
        # the project, and the guard rejects the very cleanup it exists to
        # protect. Resolving the parent still defeats `..` traversal, which is
        # the whole threat.
        try:
            (dest.parent.resolve() / dest.name).relative_to(root.resolve())
        except ValueError:
            logger.warning("[reflect] refusing to place %s outside %s", ref, root)
            return None
        return dest

    def _emplace(self, src: Path, dest: Path) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def place(self, source: "DataSource", ref: str) -> Optional[str]:
        src = Path(ref)
        dest = self._dest(source, ref)
        if dest is None or not src.exists():
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Replace rather than merge: a partially-updated asset root is a state
        # nothing downstream can reason about.
        _remove(dest)
        self._emplace(src, dest)
        return str(dest)

    def unplace(self, source: "DataSource", ref: str) -> Optional[str]:
        dest = self._dest(source, ref)
        if dest is None:
            return None
        _remove(dest)
        return str(dest)


class CopyReflector(_ProjectionReflector):
    """``copy`` — duplicate the asset root into the project."""


    def _emplace(self, src: Path, dest: Path) -> None:
        if src.is_dir():
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)


class SymlinkReflector(_ProjectionReflector):
    """``symlink`` — link the asset root into the project.

    Works for a file-layout asset. Does NOT work for a folder-layout one:
    ``gitignore_walk`` never follows symlinked directories, so the walk will not
    descend into the link and the asset is invisible to the indexer. Placement
    still succeeds — the failure is in the walk, and pretending otherwise here
    would hide it somewhere harder to find.
    """


    def _emplace(self, src: Path, dest: Path) -> None:
        dest.symlink_to(src, target_is_directory=src.is_dir())

    # ── the link is placed; the TARGET is what gets indexed ──
    #
    # `discover_record_by_path` resolves the path it is given, so an entity for
    # a symlinked file keys on the source, not the link. Reporting the link here
    # would hand the indexer a path no entity will ever carry: creates would
    # look fine (the target still resolves) while deletes silently missed,
    # leaving a row for a file that is gone.
    #
    # So symlink is a PRESENTATION choice — the project shows a link a user can
    # open — and an ADDRESSING no-op. Saying that here, once, is cheaper than
    # every caller rediscovering it.

    def place(self, source: "DataSource", ref: str) -> Optional[str]:
        return ref if super().place(source, ref) else None

    def unplace(self, source: "DataSource", ref: str) -> Optional[str]:
        return ref if super().unplace(source, ref) else None


class MaterializeReflector:
    """``materialize`` — mirror the asset repo into a local cache.

    Unlike copy/vendor this does not place files one at a time: it keeps a
    CLONE, so the cache is a real repository with history rather than a pile of
    copied bytes. That is what lets a later pull be incremental and lets the
    cache answer questions (blame, previous revisions) that a copy cannot.

    Placement is then pure arithmetic — the same repo-relative path inside the
    clone — which is why this reflector does no per-file IO at all.
    """


    def _sync_clone(self, source: "DataSource") -> Optional[Path]:
        # `_run_git` rather than a bare `subprocess.run`: it carries the house
        # timeout (an unbounded git call can hang a poll forever) and it is what
        # the git driver beside this already uses, so the package has one way to
        # run git rather than two.
        from flow_sdk.utils.git import _git_err, _run_git  # noqa: PLC0415

        root = _target_root(source)
        origin = source_root(source)
        if root is None or origin is None or not origin.exists():
            return None
        if not (root / ".git").exists():
            root.parent.mkdir(parents=True, exist_ok=True)
            result = _run_git(["git", "clone", "-q", str(origin), str(root)], str(root.parent))
        else:
            result = _run_git(["git", "pull", "-q", "--ff-only"], str(root))
        if result.returncode != 0:
            logger.warning("[reflect] %s", _git_err(result, "refresh clone"))
            return None
        return root

    def _mapped(self, source: "DataSource", ref: str) -> Optional[str]:
        root = _target_root(source)
        origin = source_root(source)
        if root is None or origin is None:
            return None
        try:
            rel = Path(ref).resolve().relative_to(origin.resolve())
        except (ValueError, OSError):
            return None
        return str(root / rel)

    def prepare(self, source: "DataSource") -> bool:
        """Refresh the clone ONCE for the whole page.

        The mirror is a property of the source, not of any single ref, so
        pulling per file would spend one git subprocess per changed path — 50
        pulls for a 50-file commit, 49 of them no-ops. `reflect_refs` calls this
        once before placing anything.
        """
        return self._sync_clone(source) is not None

    def place(self, source: "DataSource", ref: str) -> Optional[str]:
        mapped = self._mapped(source, ref)
        return mapped if mapped and Path(mapped).exists() else None

    def unplace(self, source: "DataSource", ref: str) -> Optional[str]:
        # The pull in `prepare` already removed it — report the mapped path so
        # the row goes with it.
        return self._mapped(source, ref)


#: Mode-keyed registry. Same shape as the other kind-keyed registries in the
#: tree (`fs_origin_driver`, `secret_origin_driver`, `email_inbox_driver`) —
#: register by key, look up by key, no branching at call sites.
_REGISTRY: dict[str, Reflector] = {}


def register_reflector(mode: str, reflector: Reflector) -> Reflector:
    _REGISTRY[mode] = reflector
    return reflector


def get_reflector(mode: str) -> Optional[Reflector]:
    return _REGISTRY.get(mode or ReflectMode.RECORD.value)


# Two names per behaviour where the vocabulary differs but the mechanism does
# not: `in-place` is `none` said in git, `vendor` is `copy` said in git. Stating
# the aliasing in one table is what makes it visible — as subclasses it had to
# be inferred from two declarations that changed nothing but a string.
#
# `record` is deliberately absent: it is the OTHER destination (`ingest_items`),
# and a lookup that silently returned an in-place reflector for it would route
# message payloads onto the filesystem.
_IN_PLACE, _COPY = InPlaceReflector(), CopyReflector()
for _mode in (ReflectMode.NONE, ReflectMode.IN_PLACE):
    register_reflector(_mode.value, _IN_PLACE)
for _mode in (ReflectMode.COPY, ReflectMode.VENDOR):
    register_reflector(_mode.value, _COPY)
register_reflector(ReflectMode.SYMLINK.value, SymlinkReflector())
register_reflector(ReflectMode.MATERIALIZE.value, MaterializeReflector())


def origin_id_for(source: "DataSource", ref: str) -> str:
    """The source's own name for this asset — what identity is resolved ON.

    Delegates to the DRIVER, because only it knows what its source can promise.
    A folder can offer the filesystem's own handle; a git repo offers
    `GitOrigin.key()`; Drive would offer a `fileId`. Deciding that here would
    mean this module holding one branch per provider — the shape the driver
    registry exists to prevent.

    The fallback is the source-relative path: always available, never wrong,
    only weaker (a rename reads as a new origin under it).
    """
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    driver = get_driver(source.provider)
    resolver = getattr(driver, "origin_id_for", None)
    if callable(resolver):
        try:
            resolved = (resolver(source, ref) or "").strip()
            if resolved:
                return resolved
        except Exception:
            # Never fail a poll over identity derivation — but never hide it
            # either. A silently wrong origin forks every asset it touches, and
            # keeps forking, which is far worse than a loud miss.
            logger.exception("[reflect] origin_id_for failed for %s", ref)
    return default_origin_id(source, ref)


def default_origin_id(source: "DataSource", ref: str) -> str:
    """Source-relative path. The weakest handle that is still always correct.

    The root comes from `source_root`, not from a config key: `root` is the
    folder driver's spelling and `repo` is git's, so reading either directly
    makes the fallback silently wrong for the other — `relative_to` raises and
    "always correct" quietly degrades to a bare filename that collides across
    directories.
    """
    root = source_root(source)
    try:
        rel = Path(ref).relative_to(root).as_posix() if root else Path(ref).name
    except ValueError:
        rel = Path(ref).name
    return f"{source.provider}:{source.id}:path:{rel}"


async def _find_by_origin(origin_id: str):
    """The row this origin already names, across every file-backed type.

    Fans out over ``Entity.asset_owner_classes()`` — the same candidate set and
    the same reason as ``get_by_asset_ref``: a base-class query does not reach
    concrete-type rows, and only a type that OWNS its asset may answer who owns
    an origin. Reusing that helper means a newly registered type is searchable
    here the moment it is registered, with nothing to keep in step.
    """
    import asyncio  # noqa: PLC0415

    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    if not origin_id:
        return None

    async def _try(ecls: type):
        try:
            return await ecls.get_one({"origin_id": origin_id})
        except Exception:  # noqa: BLE001 — one broken type must not sink the fan-out
            return None

    results = await asyncio.gather(*[_try(c) for c in Entity.asset_owner_classes()])
    return next((r for r in results if r is not None), None)


def _retire_stale_placement(source: "DataSource", known, placed: str) -> None:
    """Remove a previous copy of this origin that our own reflection made.

    Scoped hard to the reflect target: we delete only what we put there. A row
    whose asset lives anywhere else — the user's own tree under `none`, a path
    from some earlier configuration — is left completely alone.
    """
    root = _target_root(source)
    previous = str(getattr(known, "asset_ref", "") or "")
    if root is None or not previous or previous == placed:
        return
    old = Path(previous)
    try:
        old.relative_to(root)
    except ValueError:
        return  # not ours to remove
    try:
        _remove(old)
    except OSError:
        logger.debug("[reflect] could not retire %s", old, exc_info=True)


async def _retire_row(path: str) -> None:
    """Drop the row for a path the SOURCE has told us is gone.

    Deliberately not `reindex_paths`'s removal branch. That one cannot tell a
    deletion from an unreachable volume, so it guesses from the parent directory
    and — documented in `source_unreachable` — keeps the row when a whole
    directory disappears, on the grounds that a stale row beats a wrongly
    reaped one. Correct when the only evidence is a stat.

    Here there is better evidence. A tombstone exists only because the driver
    ENUMERATED the root successfully in this same pass; a root it cannot read
    raises `SourceError` and produces no tombstones at all. So a file missing
    from a readable root is genuinely deleted, and deleting a directory reaps
    its rows instead of leaving them searchable forever.

    Uses the same `remove_orphan_row` helper as the sweep, so the narrower
    type-scoped delete (no relationship cascade) applies here too.
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.orphan_removal import remove_orphan_row  # noqa: PLC0415

    try:
        entity = await Entity.get_by_asset_ref(path, resolve_containing=False)
    except Exception:  # noqa: BLE001
        logger.debug("[reflect] could not resolve %s for removal", path, exc_info=True)
        return
    if entity is None:
        return
    await remove_orphan_row(str(entity.id), entity.get_type())


def _stamps_identity(source: "DataSource") -> bool:
    """May we write into this source's bytes? The driver decides."""
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    return bool(getattr(get_driver(source.provider), "stamps_identity", True))


async def _reload(entity):
    """Re-read a row after an out-of-band write, so the stamp is not lost."""
    try:
        return await type(entity).get_by_id(str(entity.id))
    except Exception:  # noqa: BLE001
        return entity


async def _stamp_origin(entity, source: "DataSource", ref: str) -> None:
    """Record the origin as it stands AFTER indexing.

    Always re-read, never trust the pre-index value: the index pass may have
    rewritten the file (capsule stamp) and moved the handle underneath us.
    """
    current = origin_id_for(source, ref)
    if entity is not None and entity.origin_id != current:
        entity.origin_id = current
        await entity.save()


async def reflect_refs(
    source: "DataSource",
    refs: list[str],
    tombstones: Optional[list[str]] = None,
    renames: Optional[dict[str, str]] = None,
) -> ReflectReport:
    """Place ``refs``, unplace ``tombstones``, and consolidate on the origin.

    **Identity comes from the origin, not from the bytes.** A ref whose
    ``origin_id`` already names a row is resynced onto that row; only a genuinely
    new origin mints. That is what makes the reflect mode irrelevant to identity:
    the same source file indexed in place and copied into a project share an
    origin, so they converge on ONE entity instead of two — and neither file has
    to carry an identity capsule for it to work.

    Tombstones still go through ``reindex_paths``: removal is a question about a
    path that no longer exists, which the orphan rules already answer, and
    routing it here would duplicate them.
    """

    report = ReflectReport()
    reflector = get_reflector(source.reflect)
    if reflector is None:
        logger.warning("[reflect] no reflector for mode %r", source.reflect)
        report.skipped.extend(refs)
        return report

    # A source that does not own its bytes runs the whole page with carrier
    # writes suppressed. Scoped to the page rather than to each call because the
    # write happens deep inside `Entity.save`, and a narrower guard would leave
    # the re-stamp at the end of the loop free to dirty the file after all.
    from flow_sdk.fs_store.fs_record import carrier_writes_suppressed  # noqa: PLC0415

    from flow_sdk.builtin.faas.fs_records_actions import discover_record_by_path  # noqa: PLC0415
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
    from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415

    guard = carrier_writes_suppressed() if not _stamps_identity(source) else nullcontext()
    with guard:

        # A reflector that needs per-page setup (a clone refresh) gets it once,
        # here — never inside the per-ref loop.
        prepare = getattr(reflector, "prepare", None)
        if callable(prepare) and not prepare(source):
            report.skipped.extend(refs)
            return report

        fresh: list[tuple[str, str]] = []
        for ref in refs:
            placed = reflector.place(source, ref)
            if not placed:
                report.skipped.append(ref)
                continue
            origin_id = origin_id_for(source, ref)
            known = await _find_by_origin(origin_id)
            if known is None and (renames or {}).get(ref):
                # The source says this path IS the old one, moved. Its identity
                # lives under the ORIGIN IT HAD — for git that is computable even
                # though the old path no longer exists, because the handle is
                # repo-relative rather than a property of the file on disk.
                known = await _find_by_origin(origin_id_for(source, renames[ref]))
            if known is None:
                fresh.append((placed, ref))
                continue
            # Known origin: re-parse onto the row it already names. `proposed_id` is
            # what stops a re-parse from forking — the same thread `_resync` uses
            # when the path is unchanged, applied here when only the PATH moved.
            #
            # Clear the previous placement FIRST. After a rename, `copy` has put the
            # same bytes at a second path while the old copy is still there, and the
            # asset-occurrence rules then read the pair as a duplicate and keep the
            # ORIGINAL as primary — so the re-parse is discarded and the row stays
            # pointing at a file we are about to remove. One origin owns one
            # placement; retiring the old one is what makes that true.
            _retire_stale_placement(source, known, placed)
            await discover_record_by_path(
                known.type,
                placed,
                notify=True,
                proposed_id=str(known.id),
            )
            await _stamp_origin(await _reload(known), source, ref)
            report.placed.append(placed)

        if fresh:
            # One path for both. Under suppression `discover_record_by_path`
            # resolves read-only and mints its own id, so type inference,
            # containment and consent stay in one place either way.
            await reindex_paths([path for path, _ in fresh], [], mint=True)
            for path, ref in fresh:
                entity = await Entity.get_by_asset_ref(path, resolve_containing=True)
                if entity is None:
                    report.skipped.append(path)
                    continue
                await _stamp_origin(entity, source, ref)
                report.placed.append(path)

        for ref in tombstones or []:
            removed = reflector.unplace(source, ref)
            if removed:
                report.removed.append(removed)
        for path in report.removed:
            await _retire_row(path)

        return report
