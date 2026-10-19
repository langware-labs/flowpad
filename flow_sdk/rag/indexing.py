"""Bring a store level with a folder on disk.

The job, in one pass per root: walk, diff, chunk what changed, embed what has never been
embedded, upsert, drop what was deleted, record the folder's hash.

**Nothing here walks or hashes on its own.** ``scan_tree`` (``flow_sdk/llm_index/core.py``) is
the one engine for that — the shared gitignore-aware walk, a sha256 per file and a Merkle hash
per folder. It contains no LLM and writes nothing; it is the deterministic half of the doc
indexer, and reusing it is what stops two answers existing to "has this folder changed".

**Embedding is injected**, the way the doc indexer injects its summarizers. Production passes an
``LLMEndpoint``'s embed call; a test passes a real local embedder. That keeps the expensive,
paid, non-deterministic part out of the logic being tested, without a mock seam in the logic
itself.

**Two skips, and they are different.** A file whose content hash matches what the store recorded
is not even read. A chunk whose id the store already holds is not embedded, which catches the
sections that survived an edit elsewhere in the file. The first saves I/O, the second saves
money.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Sequence

from flow_sdk.rag.chunking import chunk_markdown
from flow_sdk.rag.store import RagStore
from flow_sdk.schema.data_spec.rag_spec import RagChunk

#: ``texts -> one vector per text``. The single seam between this module and a provider.
Embedder = Callable[[Sequence[str]], Awaitable[Sequence[Sequence[float]]]]

#: Reported per step so a caller can render progress. ``done``/``total`` are documents for the
#: scan phase and chunks for the embed phase — the second is the one that costs money.
ProgressFn = Callable[[str, int, int], None]


@dataclass
class IndexReport:
    """What one pass did. ``embedded`` is the number that cost money."""

    root: str = ""
    tree_hash: str = ""
    documents_seen: int = 0
    documents_changed: int = 0
    documents_removed: int = 0
    chunks_added: int = 0
    chunks_removed: int = 0
    embedded: int = 0
    skipped_unchanged: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def fresh(self) -> bool:
        """Nothing to do — the cheapest and most common outcome."""
        return not (self.documents_changed or self.documents_removed)


def _noop(_phase: str, _done: int, _total: int) -> None:
    pass


def _documents(root: Path) -> list[tuple[str, str, Path]]:
    """``(doc_ref, content_hash, path)`` for every source file under *root*.

    ``doc_ref`` is the absolute canonical path, not a path relative to the root: one store holds
    several roots, and a relative name would collide the moment two of them contain
    ``intro.md``. It is also what ``RagIndex.forget_root`` matches on when a root is dropped.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.llm_index.core import scan_tree  # noqa: PLC0415

    out: list[tuple[str, str, Path]] = []

    def visit(node) -> None:
        for file_node in node.files:
            out.append((canonical_posix_path(file_node.path), file_node.content_hash, file_node.path))
        for child in node.subfolders:
            visit(child)

    visit(scan_tree(root))
    return out


def remove_documents(store: RagStore, refs: Iterable[str], *, report: IndexReport | None = None) -> int:
    """Drop every chunk of each document in *refs*. Returns chunks removed."""
    removed = 0
    for doc_ref in refs:
        removed += store.remove_document(doc_ref)
    if report is not None:
        report.chunks_removed += removed
    return removed


async def index_documents(
    store: RagStore,
    documents: Iterable[tuple[str, str, Path]],
    *,
    embed: Embedder,
    model: str = "",
    report: IndexReport | None = None,
    on_progress: ProgressFn = _noop,
) -> IndexReport:
    """Chunk and embed *documents* (``(doc_ref, doc_hash, path)``), paying only for new text.

    The per-document half of a pass, usable on its own by a consumer that already knows which
    documents changed (a folder listener) and has no reason to walk the tree to find out.
    Per document, the chunks that survived the edit are kept and only the rest dropped —
    removing a changed document wholesale and re-adding it would buy the surviving sections'
    vectors a second time, which defeats the entire reason a chunk id keys on its text.
    """
    report = report if report is not None else IndexReport()
    chunks: list[RagChunk] = []
    changed = list(documents)
    for doc_ref, doc_hash, path in changed:
        try:
            text = Path(path).read_text(encoding="utf-8", errors="replace")
        except OSError as exc:  # a file that vanished mid-walk is not a failure of the pass
            report.errors.append(f"{doc_ref}: {exc}")
            continue
        chunks.extend(chunk_markdown(text, doc_ref=doc_ref, doc_hash=doc_hash))

    by_doc: dict[str, set[str]] = {}
    for chunk in chunks:
        by_doc.setdefault(chunk.doc_ref, set()).add(chunk.chunk_id)
    for doc_ref, _, _ in changed:
        report.chunks_removed += store.retain(doc_ref, by_doc.get(doc_ref, set()))

    fresh = store.unknown(chunks)
    on_progress("embed", 0, len(fresh))
    if fresh:
        vectors = await embed([c.text for c in fresh])
        report.embedded += len(fresh)
        report.chunks_added += store.add(fresh, vectors, model=model)
        on_progress("embed", len(fresh), len(fresh))
    return report


def document_hash(path: Path) -> str:
    """The content hash ``scan_tree`` records for a file — sha256 of its bytes."""
    import hashlib  # noqa: PLC0415

    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


async def index_root(
    store: RagStore,
    root: str | Path,
    *,
    embed: Embedder,
    model: str = "",
    on_progress: ProgressFn = _noop,
    force: bool = False,
) -> IndexReport:
    """Bring *store* level with *root*. Returns what it did.

    ``force`` re-reads and re-chunks every file, but still does not re-embed a chunk whose id
    the store holds — an identical section has an identical vector, and paying for it again
    would buy nothing.
    """
    from flow_sdk.fs_store.path_utils import canonical_posix_path, is_path_under  # noqa: PLC0415
    from flow_sdk.llm_index.core import scan_tree  # noqa: PLC0415

    canonical_root = canonical_posix_path(root)
    report = IndexReport(root=canonical_root)

    tree = scan_tree(Path(root))
    report.tree_hash = tree.inputs_hash
    if not force and store.tree_hash(canonical_root) == report.tree_hash:
        # The whole-tree comparison: an untouched folder costs one string compare and no reads.
        return report

    found = _documents(Path(root))
    report.documents_seen = len(found)
    indexed = store.document_hashes()

    changed = [(ref, h, p) for ref, h, p in found if force or indexed.get(ref) != h]
    report.documents_changed = len(changed)
    report.skipped_unchanged = len(found) - len(changed)
    on_progress("scan", len(found), len(found))

    # Documents that vanished from THIS root. Scoped, because the store holds other roots and
    # a whole-store prune would delete them.
    present = {ref for ref, _, _ in found}
    gone = [
        ref
        for ref in indexed
        if ref not in present and (ref == canonical_root or is_path_under(ref, canonical_root))
    ]
    report.documents_removed = len(gone)

    remove_documents(store, gone, report=report)
    await index_documents(store, changed, embed=embed, model=model, report=report, on_progress=on_progress)

    store.stamp(tree_hash=report.tree_hash, root=canonical_root)
    store.flush()
    return report


async def index_roots(
    store: RagStore,
    roots: Iterable[str],
    *,
    embed: Embedder,
    model: str = "",
    on_progress: ProgressFn = _noop,
    force: bool = False,
) -> list[IndexReport]:
    """One pass per root, sequentially.

    Sequential on purpose: the roots share one store and one usearch handle, and the expensive
    part is already batched inside a single root's embed call. Fanning out would contend for
    the same file for no gain.
    """
    return [
        await index_root(store, root, embed=embed, model=model, on_progress=on_progress, force=force)
        for root in roots
    ]


__all__ = ["Embedder", "IndexReport", "ProgressFn", "index_root", "index_roots"]
