"""TreeHasher — spec §9. The hashing fold is ``llm_index.core.fold_tree``, the
half of ``scan_tree`` below the walk; the walk is this backend's own, under the
caller's ``WalkPolicy``. The tree is folded, then streamed post-order."""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

from flow_sdk.diskio.contract import FileNodeValue, FolderNodeValue, StreamEnd, WalkPolicy
from flow_sdk.diskio.python._stream import with_end
from flow_sdk.diskio.python.tree_walker import iter_walk
from flow_sdk.llm_index.core import FileNode, FolderNode, fold_tree


def _file(node: FileNode) -> FileNodeValue:
    return FileNodeValue(rel_path=node.rel_path, content_hash=node.content_hash, title=node.title,
                         is_folder_note=node.is_folder_note, wiki_links=tuple(node.wiki_links))


def _post_order(folder: FolderNode) -> Iterator[FileNodeValue | FolderNodeValue]:
    """Subfolders, then this folder's files in name order (the folder note in
    its place), then the folder — the order ``scan_tree`` fires ``on_node`` in."""
    for sub in folder.subfolders:
        yield from _post_order(sub)
    leaves = [*folder.files, *([folder.folder_note] if folder.folder_note is not None else [])]
    for leaf in sorted(leaves, key=lambda node: node.path.name):
        yield _file(leaf)
    yield FolderNodeValue(
        rel_path=folder.rel_path,
        files=tuple(node.rel_path for node in folder.files),
        folder_note=folder.folder_note.rel_path if folder.folder_note is not None else None,
        subfolders=tuple(sub.rel_path for sub in folder.subfolders),
        own_hash=folder.own_hash,
        inputs_hash=folder.inputs_hash,
        existing_hash=folder.existing_hash,
        manual=folder.manual,
        ground_truth=folder.ground_truth,
        has_index=folder.has_index,
        index_title=folder.index_title,
    )


class PyTreeHasher:
    def scan_tree(
        self, root: str, policy: WalkPolicy, *, threads: int = 1,
    ) -> Iterator[FileNodeValue | FolderNodeValue | StreamEnd]:
        return with_end(self._nodes(Path(root), policy))

    @staticmethod
    def _nodes(root: Path, policy: WalkPolicy) -> Iterator[FileNodeValue | FolderNodeValue]:
        walk = ((dir_path, subdirs, files) for dir_path, subdirs, files, _error in iter_walk(root, policy))
        yield from _post_order(fold_tree(root, walk))
