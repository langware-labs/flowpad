"""Folder — a first-class entity representing a filesystem directory.

A Folder *references* a directory; it never owns or writes into it (no
``default_body_fn``, ``owns_main_ref=False`` — see
``schema/type_info/folder_type_info.py``). Projects attach folders as context
via the base-Entity context buckets (``add_private_context_entities`` /
``add_shared_context_entities``) with the canonical path stamped into the
per-entry sidecar; ``Project.include_dirs`` derives from those links.

Identity is deterministic: v5 ``mint_uuid`` over the canonical posix path, so
the same directory always resolves to the same entity across projects (and
re-minting after a DB wipe converges on the same id).

``git_origin`` (the Artifact pattern) records upstream git provenance for a
git-backed folder — the transportable identity a future share/materialize flow
uses. Local-only folders leave it None and are private-context material only.
"""
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.core import Entity
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.types import EntityType


class Folder(Entity):
    type: str = APIField(default=EntityType.FOLDER.value)

    # Canonical posix path of the referenced directory on THIS machine.
    # Machine-local by nature; the entity is excluded from hub payloads on the
    # private-context path, and a shared link without a locally-resolvable
    # path is skipped by consumers (see Project.include_dirs).
    path: Optional[str] = APIField(default=None, description="Canonical posix path of the referenced directory")

    # Git provenance for git-backed folders (transportable identity). Same
    # field shape as Artifact.git_origin.
    git_origin: Optional[GitOrigin] = APIField(
        default=None,
        description="Git provenance for a git-backed folder (upstream repo + branch)",
    )

    @staticmethod
    def id_for_path(path: str) -> str:
        """Deterministic v5 id for a directory path (canonicalized first)."""
        return mint_uuid(canonical_posix_path(path))

    @classmethod
    async def mint_for_path(cls, path: str) -> "Folder":
        """Get-or-create the Folder entity for ``path`` (idempotent).

        Canonicalizes the path, derives the v5 id, and returns the existing
        entity when present — otherwise creates and saves a new one. The
        single chokepoint for folder identity.
        """
        canonical = canonical_posix_path(path)
        folder_id = mint_uuid(canonical)
        existing = await cls.get_by_id(folder_id)
        if existing is not None:
            return existing
        folder = cls(
            id=folder_id,
            path=canonical,
            name=canonical.rstrip("/").rsplit("/", 1)[-1] or canonical,
        )
        await folder.save()
        return folder
