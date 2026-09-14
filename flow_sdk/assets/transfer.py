"""Portable asset bundle byte operations; no message or entity dependencies."""
import filecmp
import logging
import shutil
from pathlib import Path

from flow_sdk.assets.materialize import materialize_asset_sync

logger = logging.getLogger(__name__)

class AssetTransferConflict(FileExistsError):
    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts
        super().__init__("Asset destination contains conflicting files")

# Build/environment artifacts that must never ride inside a shared asset
# bundle. They are regenerable cruft, not skill source, and their deeply
# nested trees (a `.venv` ships `…/site-packages/pip/_internal/…/__pycache__/
# *.pyc`) blow past Windows' 260-char MAX_PATH on the receiver's extractall —
# which silently aborts the whole download. Keep this in sync with the spirit
# of a `.gitignore`: ship source, not built environments.
# Build/environment cruft — type-agnostic, never worth shipping.
_ASSET_PACK_PATTERNS: tuple[str, ...] = (
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "*.pyc",
    "*.pyo",
    "node_modules",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
)
_ASSET_PACK_IGNORE = shutil.ignore_patterns(*_ASSET_PACK_PATTERNS)


def _pack_ignore(type_name: str | None, root: Path | str):
    """The copytree filter for a folder-backed asset of ``type_name``.

    Global cruft everywhere, plus that type's ``TypeInfo.pack_exclude`` — per-type
    file policy is declared on the type, not branched on at this call site. A
    task's inner ``spec.md`` (the plan) is the motivating case: the folder is
    copied verbatim, so without this the plan rode along with every share.

    ``pack_exclude`` applies ONLY at the asset folder's own root, never deeper.
    A nested CHILD ENTITY can have the same filename — a ``spec`` entity parented
    to a task is literally a ``spec.md``, one level down under the task's folder —
    and dropping that would break the bundle's nested-entity contract (it did:
    ``test_bundle_entity_envelope_matrix`` caught it). Root-only keeps the
    distinction the filename alone can't carry: the task's own plan vs somebody
    else's entity that happens to live inside.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    extra = tuple(getattr(SchemaRegistry.get(type_name), "pack_exclude", ()) or ()) if type_name else ()
    if not extra:
        return _ASSET_PACK_IGNORE
    root_str = str(root)
    at_root = shutil.ignore_patterns(*_ASSET_PACK_PATTERNS, *extra)

    def _ignore(src_dir, names):
        return (at_root if str(src_dir) == root_str else _ASSET_PACK_IGNORE)(src_dir, names)

    return _ignore


def pack_tree(source: Path, destination: Path, *, type_name: str | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=True, ignore=_pack_ignore(type_name, source))
    else:
        materialize_asset_sync(source, destination, overwrite=True)


def restore_tree(
    entry_dir: Path,
    project_root: Path,
    *, overwrite: bool,
) -> bool:
    """Copy every file under ``attachment/<type>-@<id>/`` into ``project_root``.

    The in-bundle relpath is already the canonical ``<main_subdir>/<leaf>``
    (the packer stores it that way), so this is an anchor-free verbatim mirror
    — no per-type knowledge. Returns True when ≥1 file was restored. Raises
    ``FlowMessageExistsError`` on a genuine collision when overwrite=False;
    a byte-identical existing file is an idempotent no-op (re-receive).
    """
    from flow_sdk.fs_store.origin.git_origin import is_safe_rel_path  # noqa: PLC0415

    conflicts: list[dict] = []
    pending: list[tuple[Path, Path]] = []
    root_resolved = project_root.resolve()
    for src in entry_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(entry_dir)  # "<main_subdir>/<leaf>..." or "<rel_path>/..."
        # Path-traversal guard: the in-bundle relpath is sender-controlled (git
        # origins key the subtree by rel_path). Gate on the SAME named guard the
        # packer uses (anti-drift), then keep the resolve check as defense in depth
        # against symlink escapes a string check can't see.
        dest = project_root / rel
        if not is_safe_rel_path(rel.as_posix()):
            logger.warning("[bundle] skipping unsafe attachment path %s", rel)
            continue
        try:
            dest.resolve().relative_to(root_resolved)
        except ValueError:
            logger.warning("[bundle] skipping unsafe attachment path %s (escapes project root)", rel)
            continue
        if dest.exists() and not overwrite:
            if filecmp.cmp(src, dest, shallow=False):
                continue  # same asset already present — no-op
            conflicts.append({"path": str(dest)})
            continue
        pending.append((src, dest))
    if conflicts:
        raise AssetTransferConflict(conflicts)
    for src, dest in pending:
        materialize_asset_sync(src, dest, overwrite=overwrite)
    return bool(pending)


def remove_transferred_tree(entry_dir: Path, root: Path) -> None:
    """Remove only manifest-listed entries, keeping unrelated files and the root."""
    from flow_sdk.fs_store.origin.git_origin import is_safe_rel_path
    root = root.resolve()
    parents: set[Path] = set()
    for source in entry_dir.rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(entry_dir)
        destination = root / relative
        if not is_safe_rel_path(relative.as_posix()) or not destination.parent.resolve().is_relative_to(root):
            continue
        if destination.is_file() or destination.is_symlink():
            destination.unlink()
            parents.add(destination.parent)
    for parent in sorted(parents, key=lambda p: len(p.parts), reverse=True):
        while parent != root and parent.resolve().is_relative_to(root):
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


def _mint_rendered_asset_identity(info, body_path: Path, entry_type: str, entry_id: str) -> str:
    """Persist identity for a source-less body through the type's sole seam.

    Existing-source bundles never call this helper: their files and folder
    capsules are copied byte-for-byte. A rendered fallback is newly
    materialized, so TypeInfo may safely persist the proposed bundle id after
    the body exists (``AssetCapsule.from_path`` accepts existing paths only).
    """
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    asset_path = info.layout_of(body_path).root
    ref = FSRef(asset_path, record_type=RecordType(entry_type))
    return info.stamp_id(ref, entry_id)


def _attachment_snapshot(entry_dir: Path, entry_type: str) -> "tuple[str | None, str | None]":
    """Best-effort (name, description) for a staged attachment's chip/modal.

    Taken from the bundle at unpack time so the staged MessageAttachment can
    render without the asset entity existing locally: leaf folder/file name,
    refined by the main document's YAML frontmatter when present.
    """
    from flow_sdk.assets.frontmatter import _extract_frontmatter, _yaml_load  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(entry_type)
    main_file = getattr(info, "main_file", None) if info else None
    # Early-stop lookups (no full-tree listing): an attachment carrying a large
    # resource tree must not be walked whole on the sync path.
    main_path = None
    name: str | None = None
    if main_file:
        main_path = next((p for p in entry_dir.rglob(main_file) if p.is_file()), None)
        if main_path is not None:
            name = main_path.parent.name
    if main_path is None:
        main_path = next((p for p in entry_dir.rglob("*.md") if p.is_file()), None)
        if main_path is not None:
            name = main_path.stem
    if name is None:
        first = next((p for p in entry_dir.rglob("*") if p.is_file()), None)
        if first is not None:
            name = first.stem
    description: str | None = None
    if main_path is not None:
        try:
            fm_text = _extract_frontmatter(main_path.read_text(encoding="utf-8", errors="replace"))
            meta = _yaml_load(fm_text) if fm_text else None
            if isinstance(meta, dict):
                name = str(meta.get("name") or meta.get("title") or name or "") or name
                raw_desc = meta.get("description")
                if raw_desc:
                    description = str(raw_desc)
        except Exception:  # noqa: BLE001 — snapshot is cosmetic, never abort unpack
            pass
    return name, description
