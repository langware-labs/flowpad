"""``SearchIndex`` — a ``RagIndex`` as a block: the consumer a ``Folder`` feeds.

A view over the row (found by name, or the box's default), the way ``Inbox`` is a view over a
mailbox's source. ``apply(change)`` is the fast path: given what a folder listener observed, it
touches only those documents. The heartbeat pass stays the catch-up path — both converge on
the same per-document hashes and chunk ids, so either may run first and neither pays twice.

**Signed weights live here, not on the source.** ``FolderChange`` keeps ``added / changed /
removed / renamed`` because that is what the source observed; this block folds them into one
weight per path (+1 present, −1 gone) so a delete flows through the same code as an add and a
path that was both added and removed in one page nets to nothing. That is the settled result of
the incremental-view literature, applied one layer down from the contract that carries intent.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.blocks.delivery import Delivered
from flow_sdk.schema.data_spec.folder_change_spec import FolderChange


class SearchIndex:
    def __init__(self, name: str = ""):
        """*name* selects the index; empty means the box's default (created on first use)."""
        self.name = name
        self._index = None

    async def _ensure_index(self):
        if self._index is not None:
            return self._index
        from flow_sdk.builtin.rag_index import DEFAULT_INDEX_NAME, RagIndex  # noqa: PLC0415

        if not self.name or self.name == DEFAULT_INDEX_NAME:
            self._index = await RagIndex.ensure_default()
            return self._index
        existing = await RagIndex.get_one({"name": self.name})
        if existing is None:
            existing = RagIndex(name=self.name)
            await existing.save()
            await existing.settle_status()
        self._index = existing
        return existing

    async def apply(self, change: "FolderChange | Delivered[FolderChange]"):
        """Bring the index level with one page of changes. Returns an ``IndexReport``.

        Never raises for a refusal — a report whose ``errors`` carry the sentence, matching
        ``run_index`` — so a consumer acks and moves on; the heartbeat pass catches up once the
        index can run. Idempotent: applying a page twice embeds nothing the second time.
        """
        from flow_sdk.rag import reconcile  # noqa: PLC0415
        from flow_sdk.rag.indexing import IndexReport, document_hash, index_documents, remove_documents  # noqa: PLC0415

        spec = change.item if isinstance(change, Delivered) else change
        index = await self._ensure_index()
        report = IndexReport(root=spec.root)

        # Cover the folder if nothing does yet: the listener chose it, and a page arriving for
        # a folder the index does not cover would otherwise be silently indexed nowhere.
        if spec.root and not index.covers(spec.root):
            await index.add_root(spec.root)

        refusal = await index.settle_status()
        if refusal:
            report.errors.append(refusal)
            return report
        embed, model = await reconcile.embedder_for(index)
        if embed is None:
            report.errors.append("no embedding endpoint is available on this machine")
            return report

        weight: dict[str, int] = {}
        for path in spec.removed:
            weight[path] = weight.get(path, 0) - 1
        for new, old in spec.renamed.items():
            weight[old] = weight.get(old, 0) - 1
            weight[new] = weight.get(new, 0) + 1
        for path in [*spec.added, *spec.changed]:
            weight[path] = weight.get(path, 0) + 1

        gone = [p for p, w in weight.items() if w < 0]
        present = [p for p, w in weight.items() if w > 0 and Path(p).is_file()]
        documents = []
        for path in present:
            try:
                documents.append((path, document_hash(Path(path)), Path(path)))
            except OSError as exc:
                report.errors.append(f"{path}: {exc}")

        async with index.open_store() as store:
            remove_documents(store, gone, report=report)
            await index_documents(store, documents, embed=embed, model=model or "", report=report)
            store.flush()
            index.chunk_count = store.chunk_count()
            index.document_count = len(store.document_refs())
        report.documents_changed = len(documents)
        report.documents_removed = len(gone)
        await index.save(notify=False)
        return report

    async def search(self, question: str, *, top_k: int = 5) -> list[Any]:
        """Nearest chunks to *question*, best first. Empty when nothing funds an embedding."""
        from flow_sdk.rag import reconcile  # noqa: PLC0415

        index = await self._ensure_index()
        embed, _model = await reconcile.embedder_for(index)
        if embed is None:
            return []
        vectors = await embed([question])
        async with index.open_store() as store:
            return store.search(vectors[0], top_k=top_k)


__all__ = ["SearchIndex"]
