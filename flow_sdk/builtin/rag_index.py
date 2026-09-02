"""``RagIndex`` — one searchable index over a set of folders in a project.

A project may hold several. Each one names its own **roots** (folders you added) and covers
everything beneath them, so a large or noisy subtree can simply be left out rather than
excluded. A folder outside every root is not indexed and shows no marker.

**Roots are context links, not a stored list.** ``add_root`` mints the ``Folder`` entity and
links it into this row's private context bucket with the canonical path in the per-entry
sidecar; ``roots`` derives from those links synchronously. This mirrors
``Project.add_context_dir`` / ``Project.include_dirs`` field for field, and it is deliberate:
``Project`` used to carry a stored ``include_dirs: list[str]`` and that field was removed. A
second list of paths would be a second answer to "which folders are covered", and the ``Folder``
entity is what carries a directory's transportable identity.

**What is NOT on this row: anything that churns.** No per-file state, no per-root hash, no chunk
inventory. Those live in the store under the instance's records-data directory, because a row
rewritten on every document edit is a diff a minute in whatever watches entities — the same
reasoning that split ``DataSourceSpec`` from ``DataSource``. What this row holds is the
configuration and one verdict.

**Status and health are separate axes**, as on ``DataSource``: status answers "should this be
running", ``index_refusal`` answers "can it, right now, and if not why". A boolean could say
neither well.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import computed_field

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:
    from flow_sdk.responses.response import ApiResponse

#: The context bucket roots live in. PRIVATE, always: a root is an absolute path on THIS
#: machine, and a receiver of a shared project has no such directory. Coverage is a local fact.
_BUCKET = "private"

#: What the box's single index is called until someone renames it.
DEFAULT_INDEX_NAME = "Default RAG"

#: One asyncio lock per index id, guarding its usearch handle. See ``RagIndex.open_store``.
_STORE_LOCKS: dict[str, asyncio.Lock] = {}


class RagStatus(StrEnum):
    """Where an index is in its life. A separate axis from whether it can run right now."""

    #: Created, nothing funds embeddings yet. `verify` moves it out.
    SETUP = "setup"
    #: Indexing and answering.
    ACTIVE = "active"
    #: Paused by a person. Only a person moves it out.
    DISABLED = "disabled"


class RagIndex(Entity):
    """One vector index over the folders it was given."""

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "Brain"

    type: str = APIField(default=EntityType.RAG_INDEX.value)
    name: str = APIField(default=DEFAULT_INDEX_NAME)
    description: str = APIField(default="")

    status: RagStatus = APIField(default=RagStatus.SETUP)
    #: A covered document changed and the background pass has not caught up. Set by the
    #: post-index observer, cleared when the pass finishes. Only ever flipped false→true by
    #: that observer, so a thousand-file scan writes this row once rather than a thousand times.
    pending: bool = APIField(default=False)

    #: Which ``LLMEndpoint`` funds the embeddings. Empty ⇒ whatever funds this box.
    #: PRIVATE: a funding choice is a fact about an account, not about the work.
    endpoint_typeid: str = APIField(default="", sharing=Sharing.PRIVATE)
    #: Both pinned at the first embed. Changing either is a rebuild, not a top-up — the store
    #: refuses a vector of a different width, because two widths are two spaces.
    model: str = APIField(default="")
    dimensions: int = APIField(default=0)

    chunk_count: int = APIField(default=0)
    document_count: int = APIField(default=0)
    last_indexed_at: Optional[datetime] = APIField(default=None)
    #: Verbatim, rendered by the card and the status action. Never rewritten by a caller.
    last_error: str = APIField(default="")

    # ── roots ───────────────────────────────────────────────────────────────

    @computed_field
    @property
    def roots(self) -> list[str]:
        """The folders this index covers, derived from the context links.

        Sync and in-memory, like ``Project.include_dirs``: the indexing pass reads this on a
        hot path and must not pay a DB round-trip per call. An entry whose sidecar carries no
        locally-resolvable path is skipped rather than guessed at.
        """
        out: list[str] = []
        seen: set[str] = set()
        for tid in self.context_of_type("folder", bucket=_BUCKET):
            path = (self.get_context_entry_data(tid) or {}).get("path")
            if isinstance(path, str) and path and path not in seen:
                seen.add(path)
                out.append(path)
        return out

    def covers(self, path: str) -> str:
        """The root covering *path*, or ``""``. Pure string containment, no disk access.

        Answers the DEEPEST root when several nest, so a nested root's own settings win and a
        document is attributed to one place rather than two.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under

        candidate = canonical_posix_path(path)
        matches = [r for r in self.roots if candidate == r or is_path_under(candidate, r)]
        return max(matches, key=len) if matches else ""

    async def add_root(self, path: str) -> "ApiResponse":
        """Cover *path* and everything beneath it. Idempotent.

        Mints (or reuses) the ``Folder`` for the directory and links it privately with the
        canonical path in the sidecar, exactly as ``Project.add_context_dir`` does. The
        directory on disk is never written to, and nothing is indexed here — the background
        pass picks the new root up on its next tick.
        """
        from flow_sdk.builtin.folder import Folder
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

        if not path:
            return ApiFailResponse(message="path is required")
        canonical = canonical_posix_path(path)
        if canonical in self.roots:
            return ApiSuccessResponse(data=self.model_dump(mode="json"))

        origin = await Folder.detect_origin(canonical)
        folder = await Folder.mint_for_origin(origin, local_path=canonical)
        self.add_private_context_entities(
            folder.typeid, data={"path": canonical, "origin_kind": origin.kind}
        )
        # A new root means work to do; the pass decides how much.
        self.pending = True
        await self.save(notify=False)
        await self._announce_coverage()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    async def remove_root(self, path: str) -> "ApiResponse":
        """Stop covering *path*. No-op when it is not a root.

        Unlinks the folder and drops that root's documents from the store. The ``Folder``
        entity survives (another project may link it) and the directory is never touched.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

        if not path:
            return ApiFailResponse(message="path is required")
        canonical = canonical_posix_path(path)
        doomed = [
            tid
            for tid in self.context_of_type("folder", bucket=_BUCKET)
            if (self.get_context_entry_data(tid) or {}).get("path") == canonical
        ]
        if not doomed:
            return ApiSuccessResponse(data=self.model_dump(mode="json"))

        self.remove_private_context_entities(*doomed)
        await self.forget_root(canonical)
        # Refresh the counts before saving, so one write carries both halves of the change.
        async with self.open_store() as store:
            self.chunk_count = store.chunk_count()
            self.document_count = len(store.document_refs())
        await self.save(notify=False)
        await self._announce_coverage()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    async def _announce_coverage(self) -> None:
        """Tell every open screen that ``roots`` changed.

        ``save`` returns early when no COLUMN changed, and linking a folder only touches the
        context sidecar — so a coverage edit can be a completely silent write. Every tree in the
        app derives its marker from ``roots``, and they went on showing the old answer until
        someone reloaded. This says it explicitly rather than relying on some unrelated field
        happening to move at the same time.
        """
        await self.notify_updated()

    # ── the store ───────────────────────────────────────────────────────────

    @property
    def store_dir(self) -> Any:
        """Where this index's vectors live: inside the instance, never inside a project.

        Derived state, machine-local, and rebuildable — so it must not travel with a share and
        must not sit in a git-tracked tree. Same root as the other per-entity derived artifacts.
        """
        from flow_sdk.fs_store.record_paths import get_default_records_data_root

        return get_default_records_data_root() / EntityType.RAG_INDEX.value / str(self.id)

    @asynccontextmanager
    async def open_store(self):
        """The store, held exclusively for the duration of the block.

        usearch is a native index over files on disk, and two handles on one index — a pass
        writing while a coverage edit deletes — do not merely race, they take the process down
        with no traceback. That is not hypothetical: dropping a root during a running pass
        killed the backend outright.

        So there is one door, and it is serialized per index. The lock is per PROCESS, which is
        the whole of the exposure: the store lives under the instance's own records-data root,
        and one instance is one process.
        """
        from flow_sdk.rag.store import RagStore  # noqa: PLC0415

        lock = _STORE_LOCKS.setdefault(str(self.id), asyncio.Lock())
        async with lock:
            with RagStore(self.store_dir) as store:
                yield store

    async def forget_root(self, root: str) -> int:
        """Drop every document of *root* from the store. Returns chunks removed."""
        from flow_sdk.fs_store.path_utils import is_path_under

        async with self.open_store() as store:
            gone = 0
            for doc_ref in list(store.document_refs()):
                if doc_ref == root or is_path_under(doc_ref, root):
                    gone += store.remove_document(doc_ref)
            store.forget_tree(root)
            return gone

    # ── funding ─────────────────────────────────────────────────────────────

    async def resolve_endpoint(self) -> "Any":
        """The ``LLMEndpoint`` that funds this index's embeddings, or ``None``.

        Resolved fresh on every use rather than held, because funding changes between runs — a
        key is stored, an endpoint is bound — and a cached client would keep spending the old
        one. The bound endpoint wins; failing that, any local key that resolves.
        """
        from flow_sdk.builtin.llm_endpoint import LLMEndpoint  # noqa: PLC0415

        if self.endpoint_typeid:
            bound = await LLMEndpoint.get_by_id(self.endpoint_typeid.split("-", 1)[-1])
            if bound is not None:
                return bound
        rows = await LLMEndpoint.key_endpoints()
        return next((e for e in rows.values() if e.resolve_api_key()), None)

    async def settle_status(self) -> str:
        """Promote out of SETUP once something funds it, and back when nothing does.

        Without this an index minted before any key existed would stay in SETUP forever: the
        reconciler only dispatches ACTIVE rows, so nothing would ever look again. Called
        wherever a person touches the index, which is when the answer can have changed.

        DISABLED is a person's decision and is never overridden here.
        """
        if self.status == RagStatus.DISABLED:
            return self.index_refusal()

        endpoint = await self.resolve_endpoint()
        wanted = RagStatus.ACTIVE if endpoint is not None else RagStatus.SETUP
        reason = "" if endpoint is not None else "no embedding endpoint is available yet"
        if self.status != wanted or (wanted == RagStatus.SETUP and self.last_error != reason):
            self.status = wanted
            self.last_error = reason
            await self.save(notify=True)
        return self.index_refusal()

    # ── verdicts ────────────────────────────────────────────────────────────

    def index_refusal(self) -> str:
        """Why this index cannot run right now, or ``""`` when it can.

        The sentence, not a boolean: the reconciler logs it, the card shows it and ``verify``
        stores it, so a bare yes/no would leave each of them inventing its own wording for the
        same state.
        """
        if self.status == RagStatus.DISABLED:
            return "this index is disabled"
        if self.status == RagStatus.SETUP:
            return self.last_error or "no embedding endpoint is bound yet"
        if not self.roots:
            return "this index covers no folders yet"
        return ""

    async def destroy(self) -> None:
        """Erase the row AND its vectors.

        The generic delete removes a record's shadow folder under the records root; nothing
        sweeps the records-DATA root, so an index deleted without this leaves its vectors on
        disk forever.
        """
        import shutil  # noqa: PLC0415

        try:
            shutil.rmtree(self.store_dir)
        except (FileNotFoundError, OSError, ValueError):
            pass
        await super().destroy()

    # ── lookup ──────────────────────────────────────────────────────────────

    @classmethod
    async def covering(cls, path: str, *, project_id: str | None = None) -> "RagIndex | None":
        """The index covering *path*, or ``None``.

        Deepest root wins. Scoped to a project when one is given, because the common caller —
        the post-index observer — already knows which project the record belongs to and a
        whole-table scan per indexed file would be the wrong shape entirely.
        """
        query: dict[str, Any] = {"status": RagStatus.ACTIVE.value}
        if project_id:
            query["project_id"] = project_id
        best: "RagIndex | None" = None
        best_len = -1
        for index in await cls.get_all(query):
            root = index.covers(path)
            if root and len(root) > best_len:
                best, best_len = index, len(root)
        return best


    @classmethod
    async def ensure_default(cls) -> "RagIndex":
        """The box's one index, created on first use.

        Coverage is a per-folder decision and, until there is a reason to split, a per-folder
        decision does not need the person making it to first choose WHICH index. So the toggle
        in the tree finds this one or mints it, exactly as ``LLMEndpoint.ensure_for_secret``
        does — a lookup, never a derived id, so it converges on the row that already exists.

        Deliberately the OLDEST row rather than any row: two indexes minted by a race would
        otherwise flip which one a toggle lands on between calls.
        """
        rows = await cls.get_all({"status": RagStatus.ACTIVE.value})
        rows += await cls.get_all({"status": RagStatus.SETUP.value})
        if rows:
            return min(rows, key=lambda row: (row.created_date, str(row.id)))
        index = cls(name=DEFAULT_INDEX_NAME)
        await index.save()
        await index.settle_status()
        return index

    @classmethod
    async def toggle_root(cls, path: str) -> tuple["RagIndex", bool]:
        """Cover *path*, or stop covering it. Returns the index and whether it is now covered.

        One verb because the tree offers one button, and the button's meaning is "is this
        folder searchable". Toggling on the exact root only: a folder INSIDE a root is already
        covered, and removing it would need an exclusion list, which is a different feature.
        """
        from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

        index = await cls.ensure_default()
        canonical = canonical_posix_path(path)
        if canonical in index.roots:
            await index.remove_root(canonical)
            return index, False
        await index.add_root(canonical)
        return index, True


__all__ = ["DEFAULT_INDEX_NAME", "RagIndex", "RagStatus"]
