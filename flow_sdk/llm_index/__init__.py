"""llm_index — pure-python markdown folder-index library.

Independent of the flow_sdk entity/DB layer: stdlib only, no async, no server.
Walks a docs tree, summarises files, and assembles a Merkle tree of ``index.md``
files — with the LLM injected as two pure functions, so every deterministic step
(walk, hash, cache, render) is plain Python.

    from flow_sdk.llm_index import LLMIndexer

    idx = LLMIndexer("docs/")
    print(idx.print_index())
    stats = idx.rebuild(summarize_file, summarize_folder)
"""

from flow_sdk.llm_index.folder_note import FolderNote
from flow_sdk.llm_index.index_document import (
    FileRef,
    IndexData,
    IndexDocument,
    SubfolderRef,
)
from flow_sdk.llm_index.diff import git_unified_diff, is_binary_bytes
from flow_sdk.llm_index.indexer import (
    DocItem,
    IndexItem,
    LLMIndexer,
    RebuildStats,
    StampStats,
    typeid_for,
)
from flow_sdk.llm_index.markdown_document import MarkdownDocument

__all__ = [
    "LLMIndexer",
    "DocItem",
    "IndexItem",
    "RebuildStats",
    "StampStats",
    "typeid_for",
    "git_unified_diff",
    "is_binary_bytes",
    "MarkdownDocument",
    "FolderNote",
    "IndexDocument",
    "IndexData",
    "FileRef",
    "SubfolderRef",
]
