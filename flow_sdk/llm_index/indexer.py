"""LLMIndexer — deterministic driver for the markdown folder-index.

Pure stdlib. Python owns every deterministic step (walk, hash, the Merkle tree,
the summary cache, building :class:`IndexData`, rendering through
``MarkdownDocument``); the LLM is two **injected** pure functions::

    summarize_file(doc: DocItem, text: str) -> str     # one line for a file
    summarize_folder(item: IndexItem) -> str           # one paragraph: the scope

One filesystem tree, two iteration views: ``.docs()`` (file leaves) and
``.indexes()`` (folder nodes, post-order). ``print_index()`` renders the scanned
tree as an ASCII chart.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

from flow_sdk.llm_index.core import (
    PROMPT_VERSION,
    TEMPLATE_VERSION,
    FileNode,
    FolderNode,
    scan_tree,
)
from flow_sdk.llm_index.folder_note import FolderNote
from flow_sdk.llm_index.index_document import (
    FileRef,
    IndexData,
    IndexDocument,
    SubfolderRef,
)

SummarizeFile = Callable[["DocItem", str], str]
SummarizeFolder = Callable[["IndexItem"], str]

_TYPEID_NAMESPACE = uuid.NAMESPACE_URL


def typeid_for(path: Path | str) -> str:
    """Deterministic ``markdown_index-<uuid5>`` TypeId for a folder path."""
    return f"markdown_index-{uuid.uuid5(_TYPEID_NAMESPACE, str(Path(path).resolve()))}"


# ── items ─────────────────────────────────────────────────────────────────────


class DocItem:
    """A source file the LLM summarises. Wraps a :class:`FileNode` + the cache."""

    def __init__(self, node: FileNode, summaries_dir: Path):
        self._node = node
        self._summaries_dir = summaries_dir

    @property
    def path(self) -> Path:
        return self._node.path

    @property
    def rel_path(self) -> str:
        return self._node.rel_path

    @property
    def content_hash(self) -> str:
        return self._node.content_hash

    @property
    def title(self) -> str:
        return self._node.title

    @property
    def wiki_links(self) -> list[str]:
        return self._node.wiki_links

    @property
    def summary_path(self) -> Path:
        return self._summaries_dir / f"{self.content_hash}.summary.md"

    @property
    def is_stale(self) -> bool:
        return not self.summary_path.exists()

    def read_source(self) -> str:
        return self.path.read_text(encoding="utf-8", errors="replace")

    def get_summary(self) -> str | None:
        try:
            return self.summary_path.read_text(encoding="utf-8").strip()
        except OSError:
            return None

    def set_summary(self, text: str) -> None:
        self.summary_path.parent.mkdir(parents=True, exist_ok=True)
        self.summary_path.write_text(text.strip() + "\n", encoding="utf-8")


class IndexItem:
    """A folder that assembles into one ``index.md``. Wraps a :class:`FolderNode`."""

    def __init__(self, node: FolderNode, indexer: "LLMIndexer"):
        self._node = node
        self._idx = indexer
        self.files: list[DocItem] = [DocItem(f, indexer.summaries_dir) for f in node.files]
        self.subfolders: list[IndexItem] = [IndexItem(s, indexer) for s in node.subfolders]
        self._assembled: IndexData | None = None

    @property
    def path(self) -> Path:
        return self._node.path

    @property
    def rel_path(self) -> str:
        return self._node.rel_path

    @property
    def inputs_hash(self) -> str:
        return self._node.inputs_hash

    @property
    def is_stale(self) -> bool:
        return self._node.is_stale

    @property
    def is_manual(self) -> bool:
        return self._node.manual

    @property
    def has_folder_note(self) -> bool:
        return self._node.folder_note is not None

    @property
    def typeid(self) -> str:
        return typeid_for(self.path)

    @property
    def parent_ref(self) -> str:
        if self.path == self._idx.root:
            return ""
        return typeid_for(self.path.parent)

    def load_prior(self) -> IndexData | None:
        doc = IndexDocument.load(self.path)
        return doc.data if doc else None

    def reusable_self_summary(self, prior: IndexData | None) -> str | None:
        """Reuse the prior self-summary when this folder's own files are
        unchanged (only a descendant moved) — lets ancestors skip the LLM."""
        if not prior or not prior.self_summary:
            return None
        prior_files = sorted((f.name, f.content_hash) for f in prior.files)
        cur_files = sorted((d.path.name, d.content_hash) for d in self.files)
        return prior.self_summary if prior_files == cur_files else None

    def _file_refs(self) -> list[FileRef]:
        return [
            FileRef(
                name=doc.path.name,
                title=doc.title,
                summary=doc.get_summary() or "",
                content_hash=doc.content_hash,
            )
            for doc in self.files
        ]

    def _subfolder_refs(self) -> list[SubfolderRef]:
        refs: list[SubfolderRef] = []
        for child in self.subfolders:
            if child._assembled is not None:
                self_summary = child._assembled.self_summary
            else:
                prior = child.load_prior()
                self_summary = prior.self_summary if prior else ""
            refs.append(SubfolderRef(
                name=FolderNote.link_name(child.path),
                self_summary=self_summary,
                child_inputs_hash=child.inputs_hash,
            ))
        return refs

    def assemble(
        self,
        self_summary: str,
        *,
        process_ref: str = "",
        generated_at: str,
    ) -> IndexData:
        data = IndexData(
            typeid=self.typeid,
            parent_ref=self.parent_ref,
            vault_root=str(self._idx.root),
            folder_rel_path=self.rel_path,
            folder_name=self.path.name,
            inputs_hash=self.inputs_hash,
            template_version=TEMPLATE_VERSION,
            prompt_version=PROMPT_VERSION,
            self_summary=self_summary,
            generated_at=generated_at,
            latest_process_ref=process_ref,
            files=self._file_refs(),
            subfolders=self._subfolder_refs(),
        )
        self._assembled = data
        return data

    def write(self, data: IndexData) -> tuple[Path, Path]:
        return IndexDocument(data).write(self.path)


# ── indexer ───────────────────────────────────────────────────────────────────


@dataclass
class ScanTick:
    """A progress beat emitted during a scan. Plain/sync — the server adapts it
    into the shared IndexProgressTable/progress_report envelope."""

    folders_seen: int
    files_seen: int
    current: str


@dataclass
class RebuildStats:
    files_summarised: int
    folders_assembled: int
    total_files: int
    total_folders: int

    @property
    def fresh(self) -> bool:
        return self.files_summarised == 0 and self.folders_assembled == 0

    def __str__(self) -> str:
        if self.fresh:
            return f"INDEX FRESH ({self.total_folders} folders, 0 stale)"
        return (
            f"INDEX UPDATED: {self.files_summarised} files re-summarised, "
            f"{self.folders_assembled} folders re-assembled."
        )


class LLMIndexer:
    """Walk a docs tree and rebuild its ``index.md`` Merkle tree.

    ``path`` may be ``None`` and supplied later via :meth:`scan`. ``summaries_dir``
    is the content-addressed summary cache; it defaults to ``<root>/.llm_index``
    (which the walker ignores).
    """

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        summaries_dir: Path | str | None = None,
        force: bool = False,
    ):
        self.force = force
        self._summaries_dir = Path(summaries_dir) if summaries_dir is not None else None
        self.root: Path | None = None
        self._root_item: IndexItem | None = None
        if path is not None:
            self.scan(path)

    @property
    def summaries_dir(self) -> Path:
        if self._summaries_dir is not None:
            return self._summaries_dir
        if self.root is None:
            raise ValueError("summaries_dir is unresolved until a path is scanned")
        return self.root / ".llm_index" / "summaries"

    def scan(
        self,
        path: Path | str | None = None,
        *,
        on_tick: Callable[[ScanTick], None] | None = None,
    ) -> "LLMIndexer":
        if path is not None:
            self.root = Path(path).resolve()
        if self.root is None:
            raise ValueError("LLMIndexer.scan: no path given (and none set)")

        on_node = None
        if on_tick is not None:
            counts = {"folders": 0, "files": 0}

            def on_node(node_path: Path, kind: str) -> None:
                counts["files" if kind == "file" else "folders"] += 1
                on_tick(ScanTick(counts["folders"], counts["files"], str(node_path)))

        self._root_item = IndexItem(scan_tree(self.root, on_node=on_node), self)
        return self

    def _require_scanned(self) -> IndexItem:
        if self._root_item is None:
            raise RuntimeError("call scan() before iterating")
        return self._root_item

    # -- iteration --------------------------------------------------------------

    def indexes(self) -> Iterator[IndexItem]:
        """All folder items, post-order (leaves before parents)."""
        def visit(item: IndexItem) -> Iterator[IndexItem]:
            for sub in item.subfolders:
                yield from visit(sub)
            yield item
        yield from visit(self._require_scanned())

    def stale_indexes(self) -> Iterator[IndexItem]:
        for item in self.indexes():
            if not item.is_manual and (self.force or item.is_stale):
                yield item

    def docs(self) -> Iterator[DocItem]:
        """All source-file leaves, DFS."""
        for item in self.indexes():
            yield from item.files

    def stale_docs(self) -> Iterator[DocItem]:
        for doc in self.docs():
            if self.force or doc.is_stale:
                yield doc

    # -- rebuild ----------------------------------------------------------------

    def rebuild(
        self,
        summarize_file: SummarizeFile,
        summarize_folder: SummarizeFolder,
        *,
        process_ref: str = "",
        now: datetime | None = None,
    ) -> RebuildStats:
        """Drive a full incremental rebuild. The two summarize callables are the
        only LLM touch-points; ``summarize_folder`` is skipped (prior reused) for
        any folder whose own files are unchanged."""
        root = self._require_scanned()
        generated_at = (now or datetime.now(timezone.utc)).isoformat()

        total_folders = 0
        total_files = 0
        for item in self.indexes():
            total_folders += 1
            total_files += len(item.files)

        files_done = 0
        for doc in self.docs():
            if self.force or doc.is_stale:
                doc.set_summary(summarize_file(doc, doc.read_source()))
                files_done += 1

        folders_done = 0
        for item in self.indexes():
            if item.is_manual or not (self.force or item.is_stale):
                continue
            prior = None if self.force else item.load_prior()
            reused = item.reusable_self_summary(prior) if prior else None
            self_summary = reused if reused is not None else summarize_folder(item)
            item.write(item.assemble(
                self_summary, process_ref=process_ref, generated_at=generated_at
            ))
            folders_done += 1

        return RebuildStats(
            files_summarised=files_done,
            folders_assembled=folders_done,
            total_files=total_files,
            total_folders=total_folders,
        )

    # -- graph ------------------------------------------------------------------

    def to_graph(self) -> dict:
        """Scanned tree as ``{nodes, edges, counts}`` in the dep-graph format.

        Folders → ``markdown_index`` nodes, files → ``markdown`` nodes (both keyed
        ``<type>-<uuid5(path)>``). Edges: parent→child (``kind="child"``, the tree
        spine) and resolved ``[[wiki]]`` cross-links (``kind="context_shared"``).
        Unresolved wiki targets are dropped (no ghost nodes).
        """
        self._require_scanned()
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        nid_by_path: dict[str, str] = {}
        file_by_stem: dict[str, tuple[str, str]] = {}
        folder_by_name: dict[str, tuple[str, str]] = {}
        all_docs: list[DocItem] = []

        def add_node(type_name: str, path: Path, label: str, rel_path: str) -> tuple[str, str]:
            rp = str(path.resolve())
            nid = nid_by_path.get(rp)
            if nid is None:
                nid = nid_by_path[rp] = str(uuid.uuid5(_TYPEID_NAMESPACE, rp))
            key = f"{type_name}-{nid}"
            nodes.setdefault(
                key,
                {
                    "type": type_name,
                    "id": nid,
                    "label": label,
                    "is_ghost": False,
                    "key": key,
                    "rel_path": rel_path,
                },
            )
            return type_name, nid

        def child_edge(parent: tuple[str, str], child: tuple[str, str]) -> None:
            edges.append({
                "from": {"type": parent[0], "id": parent[1]},
                "to": {"type": child[0], "id": child[1]},
                "kind": "child",
            })

        for item in self.indexes():
            folder = add_node("markdown_index", item.path, item.path.name or "/", item.rel_path)
            folder_by_name.setdefault(FolderNote.link_name(item.path), folder)
            for doc in item.files:
                f = add_node("markdown", doc.path, doc.title, doc.rel_path)
                file_by_stem.setdefault(doc.path.stem, f)
                child_edge(folder, f)
                all_docs.append(doc)
            for sub in item.subfolders:
                child_edge(folder, add_node("markdown_index", sub.path, sub.path.name, sub.rel_path))

        # Wiki cross-links — resolved against the now-complete lookup maps.
        for doc in all_docs:
            src = file_by_stem.get(doc.path.stem)
            if src is None:
                continue
            for target in doc.wiki_links:
                dst = file_by_stem.get(target) or folder_by_name.get(target)
                if dst is not None and dst != src:
                    edges.append({
                        "from": {"type": src[0], "id": src[1]},
                        "to": {"type": dst[0], "id": dst[1]},
                        "kind": "context_shared",
                    })

        node_list = list(nodes.values())
        return {
            "nodes": node_list,
            "edges": edges,
            "counts": {"nodes": len(node_list), "edges": len(edges)},
        }

    # -- display ----------------------------------------------------------------

    def print_index(self, *, summaries: bool = True) -> str:
        """ASCII chart of the scanned tree + per-node info.

        Mirrors the BrowseableTree model: folders are containers, files are
        leaves. Annotates folders with inputs_hash prefix + fresh/stale + counts,
        and files with content_hash prefix + cached summary (when ``summaries``).
        """
        root = self._require_scanned()
        lines: list[str] = []

        def fmt_folder(item: IndexItem) -> str:
            state = "✓ fresh" if not item.is_stale else "✎ stale"
            note = " +note" if item.has_folder_note else ""
            return (
                f"{item.path.name}/  ({item.inputs_hash[:6]} · "
                f"{len(item.files)}f/{len(item.subfolders)}d · {state}{note})"
            )

        def fmt_file(doc: DocItem) -> str:
            head = f"{doc.path.name}  {doc.content_hash[:6]}"
            if summaries:
                s = doc.get_summary()
                head += f'  "{s}"' if s else "  —"
            return head

        def walk(item: IndexItem, prefix: str, is_last: bool, is_root: bool) -> None:
            if is_root:
                lines.append(fmt_folder(item))
                child_prefix = ""
            else:
                lines.append(f"{prefix}{'└── ' if is_last else '├── '}{fmt_folder(item)}")
                child_prefix = prefix + ("    " if is_last else "│   ")

            entries: list[tuple[str, object]] = (
                [("file", d) for d in sorted(item.files, key=lambda d: d.path.name)]
                + [("folder", s) for s in item.subfolders]
            )
            for i, (kind, entry) in enumerate(entries):
                last = i == len(entries) - 1
                if kind == "file":
                    branch = "└── " if last else "├── "
                    lines.append(f"{child_prefix}{branch}{fmt_file(entry)}")  # type: ignore[arg-type]
                else:
                    walk(entry, child_prefix, last, is_root=False)  # type: ignore[arg-type]

        walk(root, "", True, is_root=True)
        return "\n".join(lines)
