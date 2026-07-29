"""core — deterministic tree walk + Merkle hashing + stale-set.

Builds one :class:`FolderNode` tree from a docs root, computing:

  * per-file ``content_hash`` (sha256 of bytes) + ``title`` (via MarkdownDocument)
  * per-folder ``own_hash``    = versions + direct source files
  * per-folder ``inputs_hash`` = Merkle fold of own_hash + children's inputs_hash

The Merkle hash is content-derived only — it never hashes a rendered
``index.md`` (which would carry a timestamp), so re-running with no content
change yields identical hashes and nothing is spuriously stale. ``own_hash``
(direct files only) lets a driver reuse a folder's self-summary when only a
*descendant* changed.

A folder's summarisable "doc" leaves exclude the generated ``index.md`` and the
folder note (``<dir>/<dir>.md``) — the latter represents the folder, not content
inside it.

Two ``index.md`` frontmatter flags opt a folder out of generation, and they mean
different things — ``FolderNode.protected`` is the union of them:

  * ``manual: true`` — "I maintain this index by hand." The file IS an index;
    the human just owns it.
  * ``ground_truth: true`` — "this is human-authored authoritative content, not
    a generated index at all." Set it on a hand-written ``index.md`` that would
    otherwise look stale (no ``inputs_hash`` ⇒ ``is_stale``) and get overwritten.

Walking is delegated to the shared FSIndexer engine
(:func:`flow_sdk.fs_store.indexer.walk.gitignore_walk`), so scan scope matches
every other walker in the codebase: dot-directories ARE walked, ``.claude/`` is
force-included (except ``.claude/worktrees``), nested ``.gitignore`` files are
honored (monotonic stack, last-match-wins within a file), and the hardcoded
denylist (``node_modules``, ``.git``, flowpad state dirs ``.llm_index`` /
``.flowpad`` / ``.markdown_index``, …) is always skipped — even with
``gitignore=False``. Symlinked dirs are never followed.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from flow_sdk.fs_store.indexer.walk import gitignore_walk
from flow_sdk.llm_index.folder_note import FolderNote
from flow_sdk.llm_index.index_document import INDEX_FILENAME
from flow_sdk.llm_index.markdown_document import MarkdownDocument

TEMPLATE_VERSION = 1
PROMPT_VERSION = 1
SOURCE_EXTS = frozenset({".md", ".mdx"})


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ── nodes ─────────────────────────────────────────────────────────────────────


@dataclass
class FileNode:
    path: Path
    rel_path: str           # relative to scan root
    content_hash: str
    title: str
    is_folder_note: bool = False
    wiki_links: list[str] = field(default_factory=list)   # [[targets]] in the body


@dataclass
class FolderNode:
    path: Path
    rel_path: str           # relative to scan root, "" for root
    files: list[FileNode]               # summarisable leaves (note/index excluded)
    folder_note: FileNode | None        # the <dir>/<dir>.md, if present
    subfolders: list["FolderNode"]
    own_hash: str
    inputs_hash: str
    existing_hash: str      # inputs_hash currently on disk (index.md frontmatter)
    manual: bool            # index.md frontmatter `manual: true` → never rewrite
    ground_truth: bool = False   # `ground_truth: true` → human-authored, never rewrite
    has_index: bool = False      # an index.md exists on disk (whoever wrote it)
    index_title: str = ""        # its H1/stem, captured by the same read

    @property
    def is_stale(self) -> bool:
        return not self.existing_hash or self.existing_hash != self.inputs_hash

    @property
    def protected(self) -> bool:
        """Either opt-out flag: the generator must not write this folder's index."""
        return self.manual or self.ground_truth

    @property
    def is_generator_authored(self) -> bool:
        """The on-disk ``index.md`` carries an ``inputs_hash``, so we wrote it.

        The generator stamps ``inputs_hash`` into everything it renders, so its
        absence is proof of a hand-written file. Without this, ``existing_hash
        == ""`` collapses "no index.md at all" and "someone's own index.md" into
        one indistinguishable stale state — and the latter is the one a rebuild
        would destroy.
        """
        return self.has_index and bool(self.existing_hash)


# ── hashing ───────────────────────────────────────────────────────────────────


def _own_hash(files: list[FileNode]) -> str:
    h = hashlib.sha256()
    h.update(f"template_version={TEMPLATE_VERSION}\n".encode())
    h.update(f"prompt_version={PROMPT_VERSION}\n".encode())
    for name, fh in sorted((f.path.name, f.content_hash) for f in files):
        h.update(b"file\0" + name.encode() + b"\0" + fh.encode() + b"\n")
    return h.hexdigest()


def _merkle_hash(own_hash: str, subfolders: list[FolderNode]) -> str:
    h = hashlib.sha256()
    h.update(b"own\0" + own_hash.encode() + b"\n")
    for name, child_hash in sorted((s.path.name, s.inputs_hash) for s in subfolders):
        h.update(b"child\0" + name.encode() + b"\0" + child_hash.encode() + b"\n")
    return h.hexdigest()


# ── scan ──────────────────────────────────────────────────────────────────────


def scan_tree(
    root: Path | str,
    *,
    gitignore: bool = True,
    on_node: Callable[[Path, str], None] | None = None,
) -> FolderNode:
    """Walk ``root`` into a :class:`FolderNode` tree with hashes computed.

    ``gitignore`` toggles ``.gitignore`` filtering; the hardcoded denylist
    (``node_modules``, flowpad state dirs, …) always applies. ``on_node(path,
    kind)`` — when given — is called once per source file (``kind="file"``) and
    once per folder (``kind="folder"``, after its children), for progress
    reporting. Kept as a plain sync callback so this stays deterministic.
    """
    root = Path(root).resolve()
    if not root.is_dir():
        raise NotADirectoryError(str(root))

    # One shared-engine walk up front (pre-order); visit() below re-folds it
    # recursively so hashing stays post-order (children before parents).
    listing: dict[Path, tuple[list[Path], list[Path]]] = {}
    for dir_path, subdirs, files in gitignore_walk(root, gitignore=gitignore):
        listing[dir_path] = (
            subdirs,
            [
                f for f in files
                if f.name != INDEX_FILENAME and f.suffix.lower() in SOURCE_EXTS
            ],
        )

    def make_file_node(path: Path) -> FileNode | None:
        try:
            data = path.read_bytes()
        except OSError:
            return None
        doc = MarkdownDocument.from_text(data.decode("utf-8", "replace"), path=path)
        return FileNode(
            path=path,
            rel_path=str(path.relative_to(root)),
            content_hash=sha256_bytes(data),
            title=doc.title,
            is_folder_note=FolderNote.is_folder_note(path),
            wiki_links=doc.wiki_links,
        )

    def visit(folder: Path) -> FolderNode:
        sub_paths, file_paths = listing.get(folder, ([], []))
        subfolders = [visit(s) for s in sub_paths]
        files: list[FileNode] = []
        folder_note: FileNode | None = None
        for sf in file_paths:
            node = make_file_node(sf)
            if node is None:
                continue
            if node.is_folder_note:
                folder_note = node          # represents the folder; not a leaf
            else:
                files.append(node)
            if on_node is not None:
                on_node(node.path, "file")

        own = _own_hash(files)
        merkle = _merkle_hash(own, subfolders)

        existing_hash, manual, ground_truth, index_title = "", False, False, ""
        idx = folder / INDEX_FILENAME
        has_index = idx.is_file()
        if has_index:
            try:
                doc = MarkdownDocument.from_path(idx)
                existing_hash = str(doc.get("inputs_hash", "") or "")
                manual = bool(doc.get("manual", False))
                ground_truth = bool(doc.get("ground_truth", False))
                index_title = doc.title
            except OSError:
                pass

        node = FolderNode(
            path=folder,
            rel_path="" if folder == root else str(folder.relative_to(root)),
            files=files,
            folder_note=folder_note,
            subfolders=subfolders,
            own_hash=own,
            inputs_hash=merkle,
            existing_hash=existing_hash,
            manual=manual,
            ground_truth=ground_truth,
            has_index=has_index,
            index_title=index_title,
        )
        if on_node is not None:
            on_node(folder, "folder")
        return node

    return visit(root)


def iter_folders_post_order(node: FolderNode) -> Iterator[FolderNode]:
    for sub in node.subfolders:
        yield from iter_folders_post_order(sub)
    yield node


def iter_folders_pre_order(node: FolderNode) -> Iterator[FolderNode]:
    yield node
    for sub in node.subfolders:
        yield from iter_folders_pre_order(sub)
