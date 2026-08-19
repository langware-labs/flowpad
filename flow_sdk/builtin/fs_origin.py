"""FSOrigin — a generic, backend-agnostic pointer to where an asset's bytes live.

``FSOrigin`` answers "here is where you can find this asset." It is a thin,
secret-free, serializable value object that rides the share bundle and is
stored on file-backed/graph entities (Folder, Artifact, Task, MessageAttachment).
Git is one ``kind``; future kinds are ``local`` (a mounted folder), and later
``s3`` / ``gdrive`` / ``smb`` / ``ftp``.

Behavior — materialize (fetch/reuse bytes to a local path), matches (is this
local dir this origin?), detect (reverse: what origin is this path?), and the
credentials each of those needs — lives in a ``kind``-keyed driver registry
(``fs_origin_driver.py``), NEVER in this value object. The bundle carries a
*locator*, never a secret.

Concrete backends subclass ``FSOrigin`` with a ``Literal`` ``kind`` and their
own locator fields (see ``git_origin.GitOrigin`` / ``local_origin.LocalOrigin``).
Storage/bundle fields must be typed as the discriminated-union alias
``FSOriginField`` (``fs_origin_field.py``), not bare ``FSOrigin`` — a bare-base
field would drop the subclass locator fields on load.
"""
from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from pydantic import BaseModel

# The tolerant default kind. Legacy origins were always git and were persisted
# without a ``kind`` discriminant; anything arriving without one is git.
DEFAULT_ORIGIN_KIND = "git"


def resolve_origin_kind(value: Any) -> str:
    """The ``kind`` of a raw origin (dict or model), defaulting to git.

    Single home for the "a pointer with no ``kind`` is a legacy git origin"
    rule — shared by the union discriminator (``fs_origin_field.py``) and by
    ``is_legacy_visible_origin`` below, so the legacy default lives in exactly
    one place.
    """
    if isinstance(value, dict):
        return str(value.get("kind") or DEFAULT_ORIGIN_KIND)
    return str(getattr(value, "kind", DEFAULT_ORIGIN_KIND) or DEFAULT_ORIGIN_KIND)


def is_legacy_visible_origin(raw: Any) -> bool:
    """Whether a persisted origin may be shown to a receiver that predates kinds.

    A capability of the KIND, which is why it lives with the model rather than
    with the transport that happens to consume it. An old receiver can only
    materialize git, so anything else must stay out of the legacy share file —
    it could not act on the entry and would mis-handle it.

    Stated as a question about the kind so a NEW kind cannot be added without
    answering it: a cloud or secret origin inheriting exclusion silently is the
    failure mode this name exists to prevent.
    """
    return isinstance(raw, dict) and resolve_origin_kind(raw) == DEFAULT_ORIGIN_KIND


def is_safe_rel_path(rel_path: str) -> bool:
    """A root-relative path is safe iff it stays inside the origin root.

    ``rel_path`` is sender-controlled and gets joined onto the receiver's local
    root, so reject anything that could escape: empty, absolute, a Windows drive
    (``C:``), or any ``..`` segment. Path-traversal guard — callers MUST gate on
    this before placement. (Backend-agnostic; the git-era copy lived in
    ``git_origin`` — this is the canonical home now, re-exported there.)
    """
    if not rel_path or not rel_path.strip():
        return False
    p = rel_path.strip().replace("\\", "/")
    if p.startswith("/"):
        return False
    if len(p) >= 2 and p[1] == ":":  # windows drive letter, e.g. "C:/..."
        return False
    return ".." not in PurePosixPath(p).parts


class FSOrigin(BaseModel):
    """Base value object: a backend-tagged pointer to an asset's bytes.

    Only the truly-generic core lives here — ``kind`` (the backend
    discriminant) and ``rel_path`` (the asset root's position within the
    origin's root, the universal placement contract). Backend coordinates
    (repo/branch, bucket/region, mount base, …) live on subclasses.
    """

    # A legacy (pre-``kind``) git dict omits this key entirely; the field
    # default fills it as git on direct validation, and the union discriminator
    # (``fs_origin_field.py``) does the same on the union path — so no
    # before-validator is needed to stay tolerant of legacy origins.
    kind: str = DEFAULT_ORIGIN_KIND
    # The asset ROOT relative to the origin's root — a folder for folder-layout
    # types, a file for file-layout types. Universal across backends.
    rel_path: str = ""
    # Optional project this origin resolves inside. When set it is the most
    # direct way back to a local path — ``project.cwd`` + ``rel_path`` — without
    # inferring a checkout from repo coordinates. Empty means "resolve some
    # other way" (a local origin's ``base``, or the caller's own project), so
    # every origin persisted before this field keeps validating unchanged.
    project_id: str = ""

    @property
    def transportable(self) -> bool:
        """Whether this origin can be reconstituted on ANOTHER machine (so a
        folder/asset carrying it is shareable). Backends whose locator is
        machine-independent (git repo coords, s3 bucket, …) are transportable;
        a purely-local origin (an absolute path on one machine) is not and
        overrides this to False. The share path gates on this, not on ``kind``.
        """
        return True

    def key(self) -> str:
        """Deterministic, location-independent dedup handle for this origin.

        Delegates to the backend driver so each ``kind`` defines its own
        identity. Subclasses whose historical key must stay byte-stable (git)
        override this with their exact legacy body instead of delegating.
        """
        from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415

        return get_origin_driver(self.kind).key(self)
