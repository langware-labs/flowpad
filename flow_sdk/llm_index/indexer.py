"""LLMIndexer — deterministic driver for the markdown folder-index.

Python owns every deterministic step (walk, hash, the Merkle tree,
the summary cache, building :class:`IndexData`, rendering through
``MarkdownDocument``); the LLM is two **injected** pure functions::

    summarize_file(doc: DocItem, text: str) -> str     # one line for a file
    summarize_folder(item: IndexItem) -> str           # one paragraph: the scope

One filesystem tree, two iteration views: ``.docs()`` (file leaves) and
``.indexes()`` (folder nodes, post-order). ``print_index()`` renders the scanned
tree as an ASCII chart.
"""

from __future__ import annotations

import os
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
    sha256_bytes,
)
from flow_sdk.llm_index.diff import MAX_DIFF_BYTES, is_binary_bytes
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
        self._summary: str | None = None
        self._summary_loaded = False

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
        # Memoized per item — stamp() consults summaries twice (skip-check +
        # assemble); one cache read per file per scan snapshot is enough.
        if not self._summary_loaded:
            self._summary_loaded = True
            try:
                self._summary = self.summary_path.read_text(encoding="utf-8").strip()
            except OSError:
                self._summary = None
        return self._summary

    def set_summary(self, text: str) -> None:
        self.summary_path.parent.mkdir(parents=True, exist_ok=True)
        self.summary_path.write_text(text.strip() + "\n", encoding="utf-8")
        self._summary = text.strip()
        self._summary_loaded = True


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
    def existing_hash(self) -> str:
        """The ``inputs_hash`` currently on disk (index.md frontmatter)."""
        return self._node.existing_hash

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
class StampStats:
    """Result of a native baseline stamp (no LLM)."""

    folders_stamped: int
    folders_skipped: int      # already-fresh baselines + manual folders
    blobs_written: int
    blobs_deleted: int        # GC'd orphans
    total_files: int

    def __str__(self) -> str:
        return (
            f"BASELINE STAMPED: {self.folders_stamped} folders written, "
            f"{self.folders_skipped} fresh/manual, {self.blobs_written} blobs "
            f"(+{self.blobs_deleted} GC'd)."
        )


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
    (which the walker ignores). ``gitignore`` toggles ``.gitignore`` filtering
    in the shared walk (the hardcoded denylist always applies).
    """

    def __init__(
        self,
        path: Path | str | None = None,
        *,
        summaries_dir: Path | str | None = None,
        baseline_dir: Path | str | None = None,
        blobs_dir: Path | str | None = None,
        force: bool = False,
        gitignore: bool = True,
    ):
        self.force = force
        self.gitignore = gitignore
        self._summaries_dir = Path(summaries_dir) if summaries_dir is not None else None
        # Baseline snapshots (the native `stamp`) live OUTSIDE the vault — the
        # caller (server) resolves the per-entity data dir and passes it in.
        self._baseline_dir = Path(baseline_dir) if baseline_dir is not None else None
        self._blobs_dir = Path(blobs_dir) if blobs_dir is not None else None
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

    @property
    def baseline_dir(self) -> Path:
        if self._baseline_dir is None:
            raise ValueError("LLMIndexer needs baseline_dir for stamp/status/diff")
        return self._baseline_dir

    @property
    def blobs_dir(self) -> Path:
        if self._blobs_dir is not None:
            return self._blobs_dir
        return self.baseline_dir.parent / "blobs"

    # -- baseline ----------------------------------------------------------------

    def _baseline_json_path(self, rel_path: str) -> Path:
        return self.baseline_dir / rel_path / IndexDocument.SIDECAR

    def load_baseline(self, item: "IndexItem") -> IndexData | None:
        """Baseline for a folder: data-dir snapshot → valid in-vault sidecar → None."""
        if self._baseline_dir is not None:
            doc = IndexDocument.load_file(self._baseline_json_path(item.rel_path))
            if doc is not None:
                return doc.data
        return item.load_prior()

    def _iter_baseline_folders(self) -> Iterator[tuple[str, IndexData]]:
        """All stamped (data-dir) baseline sidecars as ``(folder_rel, data)``.

        Shared by the ghost-folder pass, the manifest diff, and blob GC — one
        walk implementation instead of three rglob copies.
        """
        if self._baseline_dir is None or not self.baseline_dir.is_dir():
            return
        for jp in sorted(self.baseline_dir.rglob(IndexDocument.SIDECAR)):
            rel = str(jp.parent.relative_to(self.baseline_dir))
            doc = IndexDocument.load_file(jp)
            if doc is not None:
                yield ("" if rel == "." else rel), doc.data

    def baseline_file(self, rel: str) -> FileRef | None:
        """Baseline FileRef for a file rel-path (works for removed folders too)."""
        if self._baseline_dir is None:
            return None
        folder_rel, _, name = rel.rpartition("/")
        doc = IndexDocument.load_file(self._baseline_json_path(folder_rel))
        if doc is None:
            return None
        return next((f for f in doc.data.files if f.name == name), None)

    def blob_path(self, content_hash: str) -> Path:
        return self.blobs_dir / content_hash

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

        self._root_item = IndexItem(
            scan_tree(self.root, gitignore=self.gitignore, on_node=on_node), self,
        )
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
        self._require_scanned()
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

    # -- baseline stamp (native, no LLM) -----------------------------------------

    def stamp(
        self,
        *,
        write_blobs: bool = True,
        max_blob_bytes: int = MAX_DIFF_BYTES,
        process_ref: str = "",
        now: datetime | None = None,
    ) -> StampStats:
        """Persist the current scan snapshot as the baseline (data-dir sidecars).

        No LLM: real content hashes + titles, summaries only from the existing
        cache / a still-valid prior. Idempotent — folders whose baseline already
        matches (inputs_hash + file-set) are skipped, so a no-change re-stamp
        rewrites nothing. ``manual: true`` folders are never stamped. With
        ``write_blobs``, file contents are stored content-addressed under
        ``blobs/<sha256>`` (size/binary-guarded) and orphans are GC'd afterwards.
        """
        self._require_scanned()
        generated_at = (now or datetime.now(timezone.utc)).isoformat()

        stamped = skipped = blobs_written = total_files = 0
        for item in self.indexes():  # post-order: children before parents
            total_files += len(item.files)
            if item.is_manual:
                skipped += 1
                continue
            prior_doc = IndexDocument.load_file(self._baseline_json_path(item.rel_path))
            prior = prior_doc.data if prior_doc else None
            # Summaries are part of the skip-check: a fresh summary in the cache
            # (e.g. after an LLM rebuild) must refresh an otherwise-unchanged baseline.
            live_set = sorted(
                (d.path.name, d.content_hash, d.get_summary() or "") for d in item.files
            )
            if (
                prior is not None
                and prior.inputs_hash == item.inputs_hash
                and sorted((f.name, f.content_hash, f.summary) for f in prior.files) == live_set
            ):
                skipped += 1
            else:
                reused = item.reusable_self_summary(prior) if prior else None
                data = item.assemble(
                    reused or "", process_ref=process_ref, generated_at=generated_at
                )
                IndexDocument(data).write_sidecar(self._baseline_json_path(item.rel_path))
                stamped += 1
            if write_blobs:
                blobs_written += self._write_blobs(item, max_blob_bytes)

        blobs_deleted = self._gc_blobs() if write_blobs else 0
        return StampStats(
            folders_stamped=stamped,
            folders_skipped=skipped,
            blobs_written=blobs_written,
            blobs_deleted=blobs_deleted,
            total_files=total_files,
        )

    def _write_blobs(self, item: "IndexItem", max_bytes: int) -> int:
        """Store folder files content-addressed. The blob key is the sha256 of the
        bytes read NOW (not the scan-time hash) — the CAS invariant (key matches
        stored content) holds even if a file changed since the scan."""
        written = 0
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        for doc in item.files:
            # Fast path: the blob for the scan-time hash is already stored —
            # skip without reading the file (no-op re-stamps stay read-free).
            if (self.blobs_dir / doc.content_hash).exists():
                continue
            try:
                data = doc.path.read_bytes()
            except OSError:
                continue
            if len(data) > max_bytes or is_binary_bytes(data):
                continue
            target = self.blobs_dir / sha256_bytes(data)
            if target.exists():
                continue
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, target)
            written += 1
        return written

    def _gc_blobs(self) -> int:
        """Delete blobs not referenced by any baseline sidecar."""
        if not self.blobs_dir.is_dir():
            return 0
        referenced: set[str] = set()
        for _rel, data in self._iter_baseline_folders():
            referenced.update(f.content_hash for f in data.files)
        deleted = 0
        for blob in self.blobs_dir.iterdir():
            if blob.is_file() and not blob.name.endswith(".tmp") and blob.name not in referenced:
                try:
                    blob.unlink()
                    deleted += 1
                except OSError:
                    pass
        return deleted

    # -- manifest diff (present vs baseline) -------------------------------------

    def diff_since_baseline(self) -> dict:
        """What changed since the last stamp, as a manifest.

        Returns ``{added, removed, modified, renamed, stale_folders,
        unindexed_folders}``. Renames are paired strictly 1:1 by content_hash;
        ambiguous (N:M) matches stay as separate add/remove. Files in folders
        with no baseline are not reported (the folder is ``unindexed``).
        """
        self._require_scanned()
        added: list[dict] = []
        removed: list[dict] = []
        modified: list[dict] = []
        stale_folders: list[str] = []
        unindexed_folders: list[str] = []
        live_rels: set[str] = set()

        for item in self.indexes():
            live_rels.add(item.rel_path)
            if item.is_manual:
                continue
            prior = self.load_baseline(item)
            if prior is None:
                unindexed_folders.append(item.rel_path)
                continue
            if prior.inputs_hash != item.inputs_hash:
                stale_folders.append(item.rel_path)
            prior_by_name = {f.name: f for f in prior.files}
            live_names: set[str] = set()
            for doc in item.files:
                live_names.add(doc.path.name)
                pf = prior_by_name.get(doc.path.name)
                if pf is None:
                    added.append({"rel": doc.rel_path, "content_hash": doc.content_hash, "title": doc.title})
                elif pf.content_hash != doc.content_hash:
                    modified.append({
                        "rel": doc.rel_path,
                        "old_hash": pf.content_hash,
                        "new_hash": doc.content_hash,
                        "old_title": pf.title,
                        "new_title": doc.title,
                    })
            for name, pf in prior_by_name.items():
                if name not in live_names:
                    rel = f"{item.rel_path}/{name}" if item.rel_path else name
                    removed.append({"rel": rel, "old_hash": pf.content_hash, "old_title": pf.title})

        # Folders that vanished entirely: their baseline files are all removed.
        for rel, data in self._iter_baseline_folders():
            if rel in live_rels:
                continue
            for f in data.files:
                frel = f"{rel}/{f.name}" if rel else f.name
                removed.append({"rel": frel, "old_hash": f.content_hash, "old_title": f.title})

        # Strict 1:1 rename pairing by content hash.
        added_by_hash: dict[str, list[dict]] = {}
        removed_by_hash: dict[str, list[dict]] = {}
        for a in added:
            added_by_hash.setdefault(a["content_hash"], []).append(a)
        for r in removed:
            removed_by_hash.setdefault(r["old_hash"], []).append(r)
        renamed: list[dict] = []
        for h, adds in added_by_hash.items():
            rems = removed_by_hash.get(h, [])
            if len(adds) == 1 and len(rems) == 1:
                renamed.append({"from_rel": rems[0]["rel"], "to_rel": adds[0]["rel"], "content_hash": h})
        renamed_hashes = {r["content_hash"] for r in renamed}
        added = [a for a in added if a["content_hash"] not in renamed_hashes]
        removed = [r for r in removed if r["old_hash"] not in renamed_hashes]

        return {
            "added": added,
            "removed": removed,
            "modified": modified,
            "renamed": renamed,
            "stale_folders": stale_folders,
            "unindexed_folders": unindexed_folders,
        }

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

        def add_node(
            type_name: str,
            path: Path,
            label: str,
            rel_path: str,
            *,
            status: str = "fresh",
            ghost: bool = False,
            generated_at: str | None = None,
        ) -> tuple[str, str]:
            rp = str(path.resolve())
            nid = nid_by_path.get(rp)
            if nid is None:
                nid = nid_by_path[rp] = str(uuid.uuid5(_TYPEID_NAMESPACE, rp))
            key = f"{type_name}-{nid}"
            node = {
                "type": type_name,
                "id": nid,
                "label": label,
                "is_ghost": ghost,
                "key": key,
                "rel_path": rel_path,
                "status": status,
            }
            if generated_at is not None:
                node["generated_at"] = generated_at
            # Post-order means a folder's own (status-bearing) node is created
            # before its parent references it — setdefault keeps the first.
            nodes.setdefault(key, node)
            return type_name, nid

        def child_edge(
            parent: tuple[str, str], child: tuple[str, str], summary: str = ""
        ) -> None:
            edge: dict = {
                "from": {"type": parent[0], "id": parent[1]},
                "to": {"type": child[0], "id": child[1]},
                "kind": "child",
            }
            if summary:
                # The indexed one-liner (FileRef.summary / child self_summary) —
                # the Atlas renders it flowing along the connecting edge.
                edge["summary"] = summary
            edges.append(edge)

        live_folder_nids: dict[str, tuple[str, str]] = {}
        baseline_by_rel: dict[str, IndexData | None] = {}
        for item in self.indexes():
            prior = self.load_baseline(item)
            baseline_by_rel[item.rel_path] = prior
            if item.is_manual:
                fstatus = "manual"
            elif prior is None:
                fstatus = "unindexed"
            elif prior.inputs_hash == item.inputs_hash:
                fstatus = "fresh"
            else:
                fstatus = "stale"
            folder = add_node(
                "markdown_index", item.path, item.path.name or "/", item.rel_path,
                status=fstatus, generated_at=(prior.generated_at if prior else None),
            )
            live_folder_nids[item.rel_path] = folder
            folder_by_name.setdefault(FolderNote.link_name(item.path), folder)

            prior_by_name = {f.name: f for f in prior.files} if prior else {}
            live_names: set[str] = set()
            for doc in item.files:
                live_names.add(doc.path.name)
                pf = prior_by_name.get(doc.path.name)
                if prior is None:
                    dstatus = "unindexed"
                elif pf is None:
                    dstatus = "added"
                elif pf.content_hash == doc.content_hash:
                    dstatus = "fresh"
                else:
                    dstatus = "modified"
                f = add_node("markdown", doc.path, doc.title, doc.rel_path, status=dstatus)
                file_by_stem.setdefault(doc.path.stem, f)
                child_edge(folder, f, summary=(pf.summary if pf else ""))
                all_docs.append(doc)

            # Baseline entries with no live file → ghost nodes under this folder,
            # with a synthesized child edge so the layout can place them.
            for name, pf in prior_by_name.items():
                if name in live_names:
                    continue
                rel = f"{item.rel_path}/{name}" if item.rel_path else name
                ghost = add_node(
                    "markdown", item.path / name, pf.title or Path(name).stem, rel,
                    status="removed", ghost=True,
                )
                child_edge(folder, ghost, summary=pf.summary)

            for sub in item.subfolders:
                # Post-order: the child's baseline was loaded before its parent.
                sub_prior = baseline_by_rel.get(sub.rel_path)
                child_edge(
                    folder,
                    add_node("markdown_index", sub.path, sub.path.name, sub.rel_path),
                    summary=(sub_prior.self_summary if sub_prior else ""),
                )

        # Folders that vanished entirely (baseline exists, no live dir) → ghost
        # section nodes attached to their nearest surviving (or ghost) ancestor.
        if self.root is not None:
            ghost_folder_nids: dict[str, tuple[str, str]] = {}
            for rel, _data in self._iter_baseline_folders():
                if rel in live_folder_nids or not rel:
                    continue
                name = rel.rsplit("/", 1)[-1]
                ghost = add_node(
                    "markdown_index", self.root / rel, name, rel, status="removed", ghost=True,
                )
                ghost_folder_nids[rel] = ghost
                parent_rel = rel.rsplit("/", 1)[0] if "/" in rel else ""
                while True:
                    anchor = ghost_folder_nids.get(parent_rel) or live_folder_nids.get(parent_rel)
                    if anchor is not None:
                        child_edge(anchor, ghost)
                        break
                    if "/" not in parent_rel:
                        anchor = live_folder_nids.get("")
                        if anchor is not None:
                            child_edge(anchor, ghost)
                        break
                    parent_rel = parent_rel.rsplit("/", 1)[0]

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
