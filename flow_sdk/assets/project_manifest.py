"""The project manifest on disk — read, write, and the read contract.

Pure functions over a project root (``Path``): no DB, no ``Entity``, no
registry. This is the module a DB-less reader imports — the hub, which serves
the Published section straight from the git tree it already holds for a
project, the same way it serves docs. Everything that touches an entity row
lives in ``flow_sdk.builtin.project_manifest``.

Layout::

    <project root>/agentic-assets/project_manifest/
        project_manifest.json          ← the ledger (``ProjectManifestSpec``)
        .flow/capsules/identity.json   ← the manifest's own v4 id (sidecar)

Writes are serialized across processes by a file lock on the manifest path
and land atomically (``capsule_lock`` / ``atomic_write``); a byte-identical
write is skipped, which is what lets a reconcile pass converge without
touching mtime.

**Read contract** — ``GET /api/v1/graph/project/<id>/published`` (desk) and the
hub's equivalent return the same shape::

    {
      "manifest": {"exists": bool, "schema": int, "requires": {…},
                   "rel_path": "agentic-assets/project_manifest/project_manifest.json",
                   "typeid": "project_manifest-<uuid>" | null},
      "rows": [
        {"typeid", "type", "id", "name", "description", "rel_path", "published_at",
         "state": "in_use" | "install" | "stale" | "missing",
         "posix_path": str | null,        # desk only
         "indexed": bool}                 # desk only
      ],
      "unpublished": [ {"typeid", "type", "name", "posix_path", "project_id"} ]   # desk only; [] on the hub
    }

State on the hub is what a tree can tell: ``in_use`` when ``rel_path`` exists
in the tree, ``missing`` when it does not (``state_in_tree``). The desk adds
``install`` (present on disk, no row yet — pulled via git, not indexed) and
``stale`` (row exists, carrier newer than ``published_at``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from filelock import FileLock
from pydantic import ValidationError

from flow_sdk.capsules.atomic import atomic_write, capsule_lock
from flow_sdk.fs_store.placement import AGENTIC_ASSETS_DIR
from flow_sdk.instances.model import utc_now_iso
from flow_sdk.schema.data_spec.project_manifest_spec import (
    DEPS_MAIN,
    PROJECT_MANIFEST_MAIN,
    DependenciesSpec,
    DependencySpec,
    ProjectManifestSpec,
    PublishedAssetSpec,
)

MANIFEST_TYPE = "project_manifest"
MANIFEST_REL_DIR = f"{AGENTIC_ASSETS_DIR}/{MANIFEST_TYPE}"
MANIFEST_REL_PATH = f"{MANIFEST_REL_DIR}/{PROJECT_MANIFEST_MAIN}"


class ManifestError(ValueError):
    """The file exists but cannot be read as a ledger (malformed JSON, a
    schema this build does not read, a row that fails validation)."""


def manifest_dir(root: Path) -> Path:
    return Path(root) / AGENTIC_ASSETS_DIR / MANIFEST_TYPE


def manifest_path(root: Path) -> Path:
    return manifest_dir(root) / PROJECT_MANIFEST_MAIN


def deps_path(root: Path) -> Path:
    return manifest_dir(root) / DEPS_MAIN


# ── the one ledger core: both files are the same shape, read and written the
# same way (a byte-identical write is skipped; dropping an absent row never
# creates the file). ────────────────────────────────────────────────────────


def _parse(text: str, cls: type[ProjectManifestSpec], label: str) -> ProjectManifestSpec:
    """Text → spec. The one place the file's rules are applied, so a hub reader
    holding bytes from git and the desk reader holding a file agree."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ManifestError(f"{label} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ManifestError(f"{label} root must be an object")
    try:
        return cls.model_validate(data)
    except ValidationError as exc:
        raise ManifestError(f"{label} failed validation: {exc}") from exc


def _read(path: Path, cls: type[ProjectManifestSpec]) -> Optional[ProjectManifestSpec]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    return _parse(text, cls, path.name)


def _render(spec: ProjectManifestSpec) -> bytes:
    return (json.dumps(spec.to_document(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _write(path: Path, spec: ProjectManifestSpec) -> Path:
    atomic_write(path, _render(spec), new_mode=0o644)
    return path


def _upsert(path: Path, cls: type[ProjectManifestSpec], entry) -> ProjectManifestSpec:
    with capsule_lock(path):
        spec = (_read(path, cls) or cls.empty()).with_entry(entry)
        _write(path, spec)
        return spec


def _drop(path: Path, cls: type[ProjectManifestSpec], typeid: str) -> ProjectManifestSpec:
    with capsule_lock(path):
        current = _read(path, cls)
        if current is None or current.find(typeid) is None:
            return current or cls.empty()
        spec = current.without(typeid)
        _write(path, spec)
        return spec


# ── project_manifest.json — what this project PUBLISHED ─────────────────────


def parse_manifest(text: str) -> ProjectManifestSpec:
    return _parse(text, ProjectManifestSpec, PROJECT_MANIFEST_MAIN)


def read_manifest(root: Path) -> Optional[ProjectManifestSpec]:
    """The manifest under ``root``, or None when the project has none."""
    return _read(manifest_path(root), ProjectManifestSpec)


def load_or_empty(root: Path) -> ProjectManifestSpec:
    return read_manifest(root) or ProjectManifestSpec.empty()


def write_manifest(root: Path, spec: ProjectManifestSpec) -> Path:
    return _write(manifest_path(root), spec)


def locked(root: Path) -> FileLock:
    """The cross-process lock every read-modify-write of the manifest takes."""
    return capsule_lock(manifest_path(root))


def rel_path_for(root: Path, asset_root: Path) -> Optional[str]:
    """``asset_root`` as a POSIX path relative to ``root``, or None when it is
    not inside the project (the root itself is not an asset)."""
    root_r, asset_r = Path(root).resolve(), Path(asset_root).resolve()
    if asset_r == root_r or not asset_r.is_relative_to(root_r):
        return None
    return asset_r.relative_to(root_r).as_posix()


def make_entry(
    *,
    typeid: str,
    rel_path: str,
    name: str = "",
    description: str = "",
    now: Optional[str] = None,
    origin=None,
) -> PublishedAssetSpec:
    return PublishedAssetSpec(
        typeid=typeid,
        rel_path=rel_path,
        name=name,
        description=description,
        published_at=now or utc_now_iso(),
        origin=origin,
    )


def publish(root: Path, entry: PublishedAssetSpec) -> ProjectManifestSpec:
    """Add or replace ``entry``; returns the manifest as written."""
    return _upsert(manifest_path(root), ProjectManifestSpec, entry)


def unpublish(root: Path, typeid: str) -> ProjectManifestSpec:
    """Drop the row for ``typeid``. Absent row, absent file: nothing is
    written — unpublishing must never create a manifest."""
    return _drop(manifest_path(root), ProjectManifestSpec, typeid)


def state_in_tree(root: Path, entry: PublishedAssetSpec) -> str:
    """What a bare tree can say about a row: the carrier is there or it isn't."""
    return "in_use" if (Path(root) / entry.rel_path).exists() else "missing"


# ── deps.json — what this project INSTALLED ─────────────────────────────────


def parse_deps(text: str) -> DependenciesSpec:
    return _parse(text, DependenciesSpec, DEPS_MAIN)  # type: ignore[return-value]


def read_deps(root: Path) -> Optional[DependenciesSpec]:
    return _read(deps_path(root), DependenciesSpec)  # type: ignore[return-value]


def deps_locked(root: Path) -> FileLock:
    """Its own lock — the manifest's lock is per manifest path."""
    return capsule_lock(deps_path(root))


def make_dependency(
    *, entry: PublishedAssetSpec, source_project_id: str, source_project_name: str = "", now: Optional[str] = None
) -> DependencySpec:
    return DependencySpec(
        **entry.model_dump(),
        source_project_id=source_project_id,
        source_project_name=source_project_name,
        installed_at=now or utc_now_iso(),
    )


def record_dependency(root: Path, dep: DependencySpec) -> DependenciesSpec:
    """Add or replace the row for ``dep.typeid``; returns the ledger as written."""
    return _upsert(deps_path(root), DependenciesSpec, dep)  # type: ignore[return-value]


def forget_dependency(root: Path, typeid: str) -> DependenciesSpec:
    return _drop(deps_path(root), DependenciesSpec, typeid)  # type: ignore[return-value]
