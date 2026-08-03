"""Folder — a first-class entity representing a filesystem directory.

A Folder *references* a directory; it never owns or writes into it (no
``default_body_fn``, ``owns_main_ref=False`` — see
``schema/type_info/folder_type_info.py``). Projects attach folders as context
via the base-Entity context buckets (``add_private_context_entities`` /
``add_shared_context_entities``) with the canonical path stamped into the
per-entry sidecar; ``Project.include_dirs`` derives from those links.

A Folder's LOCATION is an ``FSOrigin`` (the transportable source of truth):
- ``LocalOrigin`` (``kind="local"``) — a plain directory on this machine
  (``base`` = its canonical path). Non-transportable: never shareable.
- ``GitOrigin`` (``kind="git"``) — a directory inside a git repo (repo coords +
  ``rel_path``). Transportable: it can be reconstituted on another machine by
  cloning, so a shared project can carry it.

``path`` is the LOCAL resolved-path cache (per machine): set at add time on the
sender (the dir is local), and set on a receiver only after ``resolve_location``
materializes the origin. It is the local view; ``origin`` is what travels.

Identity: ``origin.key()`` for transportable (git) origins — byte-stable and
machine-independent, so sender and receiver mint the SAME folder id and a shared
context ref resolves. Local origins keep the legacy path-derived v5 id
(``mint_uuid(canonical_posix_path(base))``), so existing local folders + their
links are untouched (zero migration).
"""

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.fs_origin import FSOrigin, is_safe_rel_path
from flow_sdk.builtin.fs_origin_field import FSOriginField
from flow_sdk.builtin.local_origin import LocalOrigin
from flow_sdk.core import Entity, action
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.types import EntityType


class Folder(Entity):
    type: str = APIField(default=EntityType.FOLDER.value)

    # Where the folder lives — the transportable source of truth (local / git /
    # future s3/drive). Typed as the discriminated union so the right subclass
    # (with its locator fields) reconstructs on load.
    origin: Optional[FSOriginField] = APIField(
        default=None,
        description="FSOrigin locating the directory (local base / git repo+rel_path / …).",
    )

    # LOCAL resolved-path cache on THIS machine (see module docstring). Not the
    # transportable identity; set at add time (sender) or on resolve (receiver).
    path: Optional[str] = APIField(default=None, description="Local resolved path of the directory (per-machine cache)", sharing=Sharing.PRIVATE)

    def __init__(self, **data):
        # Tolerant backfill: an old row / bundle may carry a legacy ``path`` or
        # ``git_origin`` (dict, possibly under ``metadata``) but no ``origin``.
        # Synthesize ``origin`` so it loads without a DB migration. Mirrors
        # Artifact.__init__'s lift-from-metadata.
        if not data.get("origin"):
            metadata = data.get("metadata") or {}
            legacy_git = data.get("git_origin") or metadata.get("git_origin")
            if legacy_git:
                data["origin"] = legacy_git  # discriminated union reads kind→git
            elif data.get("path"):
                data["origin"] = LocalOrigin(base=canonical_posix_path(data["path"]))
        data.pop("git_origin", None)  # dropped field — never let it reach the model
        super().__init__(**data)

    def _hub_body(self) -> dict:
        """Folder hub payload: strip non-transportable origins.

        Folders normally travel as project context refs plus
        ``shared_context_origins``. The local resolved ``path`` is withheld by
        the field declaration itself (``Sharing.PRIVATE``); what remains here is
        the runtime check that an origin is transportable, which no per-field
        policy can express.
        """
        body = super()._hub_body()
        # `path` is withheld by the base seam now (declared PRIVATE); this
        # override is left with the one thing that is NOT per-field policy — a
        # runtime predicate on the origin's transportability.
        origin = self.origin
        if origin is None or not origin.transportable:
            body.pop("origin", None)
        return body

    # ── Identity ─────────────────────────────────────────────────────────────

    @staticmethod
    def id_for_path(path: str) -> str:
        """Deterministic v5 id for a LOCAL directory path (canonicalized).

        The legacy local-folder identity — kept byte-identical so existing local
        folders and their context-links never re-key.
        """
        return mint_uuid(canonical_posix_path(path))

    @staticmethod
    def id_for_origin(origin: FSOrigin) -> str:
        """Folder id = the origin's own key. Uniform across kinds: git →
        machine-independent repo key (shared refs resolve); local →
        ``local_origin_key`` == canonical path == ``id_for_path`` (byte-stable,
        zero migration). No kind-branch — each origin owns its identity."""
        return origin.key()

    # ── Minting ──────────────────────────────────────────────────────────────

    @staticmethod
    async def detect_origin(path: str) -> FSOrigin:
        """Classify a local path into an origin: a directory inside a git repo →
        ``GitOrigin`` (transportable, whole-repo clone + rel_path); otherwise a
        plain ``LocalOrigin``. Runs a blocking git probe — async only."""
        from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415

        canonical = canonical_posix_path(path)
        try:
            detected = await get_origin_driver("git").detect(canonical)
        except Exception:
            detected = None
        return detected if detected is not None else LocalOrigin(base=canonical)

    @staticmethod
    def derive_name(origin: FSOrigin, local_path: Optional[str] = None) -> Optional[str]:
        """Human display name for a folder at this origin.

        The leaf of the repo-relative position when there is one; for a repo
        ROOT (``rel_path`` empty or ``"."``) fall through to the repository
        name, then the local base/path leaf. ``"."`` is never a name — it was
        what repo-root git folders used to get, rendering as a bare typeid.
        """
        candidates = (
            origin.rel_path or "",
            getattr(origin, "name", "") or "",
            getattr(origin, "base", "") or "",
            local_path or "",
        )
        for candidate in candidates:
            leaf = candidate.strip().rstrip("/").rsplit("/", 1)[-1].strip()
            if leaf and leaf != ".":
                return leaf
        return None

    @classmethod
    async def mint_for_origin(cls, origin: FSOrigin, *, local_path: Optional[str] = None) -> "Folder":
        """Get-or-create the Folder for ``origin`` (idempotent, keyed by
        ``id_for_origin``). ``local_path`` is the resolved local dir when known
        (sender add-time); a bare received origin leaves it None until
        ``resolve_location`` materializes it."""
        folder_id = cls.id_for_origin(origin)
        existing = await cls.get_by_id(folder_id)
        if existing is not None:
            return existing
        # ``path`` (local cache) is set when the caller knows the local dir
        # (sender add-time); a bare received origin leaves it None until
        # ``resolve_location`` materializes it.
        folder = cls(
            id=folder_id,
            origin=origin,
            path=local_path,
            name=cls.derive_name(origin, local_path),
        )
        await folder.save()
        return folder

    @classmethod
    async def mint_for_path(cls, path: str) -> "Folder":
        """Get-or-create the Folder for a LOCAL directory path (idempotent).

        Detects whether the dir is inside a git repo (→ transportable GitOrigin)
        or plain (→ LocalOrigin), then mints by origin. The single chokepoint
        the context-folder add path uses; the dir is local here, so the local
        ``path`` cache is set for both kinds.
        """
        canonical = canonical_posix_path(path)
        origin = await cls.detect_origin(canonical)
        return await cls.mint_for_origin(origin, local_path=canonical)

    @classmethod
    async def borrowed_checkout_paths(cls) -> set:
        """Canonical paths of every directory we materialized from a TRANSPORTABLE
        origin — i.e. every checkout of somebody else's repo.

        These are bytes we clone but do not author, and indexing must never
        write into them: identity backends normally COMMIT the id they mint
        back into the source (markdown gets a ``flowpad:capsule`` block
        appended), which dirties every tracked file and makes the vendor's next
        ``git pull`` abort on "local changes would be overwritten" — silently,
        until somebody tries to update the folder.

        Answered from the Folder rows rather than by a per-path probe because
        the Folder IS the record of "this directory came from elsewhere". A
        caller that has a root and wants to know whether it may write asks
        here; it does not need to know how the directory was attached, which is
        the whole reason this lives on the entity and not at the call sites
        (there are at least three: context-folder add, folder resolve, and the
        project walk that owns a checkout it did not attach).
        """
        paths = set()
        for folder in await cls.get_all():
            origin = folder.origin
            if origin is None or not origin.transportable or not folder.path:
                continue
            paths.add(canonical_posix_path(folder.path))
        return paths

    # ── Materialize ──────────────────────────────────────────────────────────

    @action.post(action_name="resolve-location")
    async def resolve_location(self, *, preferred_root=None, strict_index: bool = False) -> "object":
        """Materialize this folder's origin into a local path on THIS machine.

        ``preferred_root`` directs where a fresh checkout lands. Callers that
        manage a folder on the user's behalf (a helpdesk portal, say) pass a
        root outside the visible workspace; ordinary context folders pass
        nothing and take the driver's default placement.

        Indexing remains best-effort for ordinary folder resolution. Install
        flows pass ``strict_index=True`` because they must not link a content
        project whose assets were not discovered successfully.

        For a ``local`` origin: verify base+rel exist, set ``path``. For a
        transportable origin (git/…): clone/pull via the kind's driver, join the
        guarded ``rel_path``, set ``path``, save. Mirrors
        ``Artifact.resolve_git_location``; never raises — returns a
        ``ready``/``error`` envelope so the caller (project resolve) can stamp
        its own sidecar or surface needs-attention.
        """
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415
        from flow_sdk.responses.response import ApiSuccessResponse  # noqa: PLC0415

        origin = self.origin
        if origin is None:
            return ApiSuccessResponse(data={"kind": "error", "message": "Folder has no origin"})
        rel = origin.rel_path or ""
        if rel and not is_safe_rel_path(rel):
            return ApiSuccessResponse(data={"kind": "error", "message": "origin has an unsafe rel_path"})
        try:
            local_root, _project_id = await get_origin_driver(origin.kind).materialize(
                origin, preferred_root=preferred_root
            )
        except FileNotFoundError as exc:
            return ApiSuccessResponse(data={"kind": "error", "message": f"not present: {exc}"})
        except Exception as exc:  # driver/materialize failure (clone error, etc.)
            return ApiSuccessResponse(data={"kind": "error", "message": str(exc)})
        # Driver contract: materialize returns the ROOT; join rel_path (guarded)
        # as the placement step, then confirm it stayed inside the root.
        root = Path(local_root)
        target = (root / rel.replace("\\", "/")) if rel else root
        try:
            target.resolve().relative_to(root.resolve())
        except (ValueError, OSError):
            return ApiSuccessResponse(data={"kind": "error", "message": "resolved path escaped origin root"})
        if not target.exists():
            return ApiSuccessResponse(data={"kind": "error", "message": f"resolved path not found: {target}"})
        if not target.is_dir():
            return ApiSuccessResponse(data={"kind": "error", "message": f"resolved path is not a directory: {target}"})
        self.path = canonical_posix_path(str(target))
        await self.save()
        try:
            from flow_sdk.builtin.agentic_process.agentic_process import (  # noqa: PLC0415
                _index_additional_dir,
            )

            # A transportable origin means these bytes came from somewhere else
            # — a repo we clone but do not author. Indexing normally COMMITS the
            # id it mints back into the source (markdown gets a
            # ``flowpad:capsule`` block appended), which dirties the whole
            # checkout and makes the next ``git pull`` abort on "local changes
            # would be overwritten". Owning the distinction here, at the one
            # place that knows the origin, keeps every caller of
            # ``resolve_location`` from having to remember it.
            await _index_additional_dir(self.path, read_only=origin.transportable)
        except Exception as exc:
            if strict_index:
                return ApiSuccessResponse(data={"kind": "error", "message": str(exc)})
        return ApiSuccessResponse(data={"kind": "ready", "path": self.path})
