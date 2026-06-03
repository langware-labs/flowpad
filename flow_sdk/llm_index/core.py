"""core — deterministic tree walk + Merkle hashing + stale-set.

Pure stdlib. Builds one :class:`FolderNode` tree from a docs root, computing:

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
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from flow_sdk.llm_index.folder_note import FolderNote
from flow_sdk.llm_index.index_document import INDEX_FILENAME
from flow_sdk.llm_index.markdown_document import MarkdownDocument

TEMPLATE_VERSION = 1
PROMPT_VERSION = 1
SOURCE_EXTS = frozenset({".md", ".mdx"})
IGNORE_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
    ".flowpad", ".markdown_index", ".llm_index",
})


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

    @property
    def is_stale(self) -> bool:
        return not self.existing_hash or self.existing_hash != self.inputs_hash


# ── listing ───────────────────────────────────────────────────────────────────


def _list_subfolders(folder: Path) -> list[Path]:
    out: list[Path] = []
    try:
        for entry in sorted(folder.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name in IGNORE_DIRS or entry.name.startswith("."):
                continue
            try:
                if entry.is_symlink():
                    continue
            except OSError:
                continue
            out.append(entry)
    except OSError:
        pass
    return out


def _list_source_files(folder: Path) -> list[Path]:
    out: list[Path] = []
    try:
        for entry in sorted(folder.iterdir()):
            if not entry.is_file() or entry.name == INDEX_FILENAME:
                continue
            if entry.suffix.lower() in SOURCE_EXTS:
                out.append(entry)
    except OSError:
        pass
    return out


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
    on_node: Callable[[Path, str], None] | None = None,
) -> FolderNode:
    """Walk ``root`` into a :class:`FolderNode` tree with hashes computed.

    ``on_node(path, kind)`` — when given — is called once per source file
    (``kind="file"``) and once per folder (``kind="folder"``, after its children),
    for progress reporting. Kept as a plain sync callback so this stays pure.
    """
    root = Path(root).resolve()
    if not root.is_dir():
        raise NotADirectoryError(str(root))

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
        subfolders = [visit(s) for s in _list_subfolders(folder)]
        files: list[FileNode] = []
        folder_note: FileNode | None = None
        for sf in _list_source_files(folder):
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

        existing_hash, manual = "", False
        idx = folder / INDEX_FILENAME
        if idx.is_file():
            try:
                doc = MarkdownDocument.from_path(idx)
                existing_hash = str(doc.get("inputs_hash", "") or "")
                manual = bool(doc.get("manual", False))
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
