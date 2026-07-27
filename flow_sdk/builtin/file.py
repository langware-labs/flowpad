"""File entity — a DB-only handle for a file on disk outside the record store.

SemanticLock targets are "any entity"; this type is the adapter that gives
plain files (source code, configs) an entity end for a DependsOn edge. It is
non-indexed: no asset_ref, no FSRecord, never walked and never orphan-swept.

Identity is deterministic and portable (uuid5 via ``mint_uuid``):
  * inside a git checkout → ``git:{provider}:{owner}/{name}:{rel_path}`` —
    the SAME id on every machine/checkout of that repo;
  * otherwise → ``machine:{machine_id}:{abs_path}``.
The scheme prefixes keep the two keyspaces disjoint. rel_path is
NFC-normalized so macOS/Linux unicode-normalization differences cannot mint
two ids for one file.
"""

from __future__ import annotations

import uuid
from pathlib import Path, PurePosixPath

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.types import EntityType
from flow_sdk.utils.git import find_project_root, git_remote_url
from flow_sdk.utils.git_identity import canonical_git_origin_repo_key, parse_git_origin_url


class File(Entity):
    type: str = APIField(default=EntityType.FILE.value)

    # Path relative to the enclosing git checkout root ("" when machine-scoped).
    rel_path: str = APIField(default="")
    # Last known absolute path on THIS machine (resolution hint, not identity).
    abs_path: str = APIField(default="")
    # Canonical repo key ("git:{provider}:{owner}/{name}") or "" when
    # machine-scoped.
    repo_key: str = APIField(default="")
    # Stable machine id — set only for machine-scoped files.
    machine_id: str = APIField(default="")

    @property
    def display_name(self) -> str:
        return Path(self.rel_path or self.abs_path).name or self.name or ""


def file_identity_key(path: str | Path) -> tuple[str, str, str, str]:
    """Deterministic identity key for a file path.

    Returns ``(key, repo_key, rel_path, machine_id)`` — repo_key/rel_path
    empty for machine-scoped files, machine_id empty for repo-scoped ones.
    The key feeds ``mint_uuid``; both branches are scheme-prefixed so the
    keyspaces can never collide. Paths go through ``canonical_posix_path``
    (resolve + posix separators + NFC) so the same repo file mints the same
    id on every OS.
    """
    canon = canonical_posix_path(path)
    root = find_project_root(canon)
    if root:
        remote = git_remote_url(root)
        parsed = parse_git_origin_url(remote) if remote else None
        if parsed is not None:
            provider, owner, name = parsed
            repo_key = canonical_git_origin_repo_key(provider, owner, name)
            rel = str(PurePosixPath(canon).relative_to(canonical_posix_path(root)))
            return (f"{repo_key}:{rel}", repo_key, rel, "")
    from flow_sdk.utils.machine_id import get_machine_id  # noqa: PLC0415

    machine_id = get_machine_id()
    return (f"machine:{machine_id}:{canon}", "", "", machine_id)


async def ensure_file_entity(path: str | Path) -> File:
    """Deterministic get-or-create for a file's entity handle. The existing
    row's identity fields stay untouched; ``abs_path`` (a resolution hint,
    not identity) is refreshed when the file moved/resolved elsewhere."""
    canon = canonical_posix_path(path)
    key, repo_key, rel, machine_id = file_identity_key(canon)
    fid = mint_uuid(key=key, namespace=uuid.NAMESPACE_URL)
    existing = await File.get_one({"id": fid})
    if existing is not None:
        if canon != existing.abs_path:
            existing.abs_path = canon
            await existing.save()
        return existing
    ent = File(
        id=fid,
        rel_path=rel,
        abs_path=canon,
        repo_key=repo_key,
        machine_id=machine_id,
    )
    await ent.save()
    return ent
