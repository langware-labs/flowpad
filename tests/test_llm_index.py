"""Unit tests for the pure-python flow_sdk.llm_index library.

No LLM, no DB, no server — drives LLMIndexer.rebuild() with stub summarizers and
asserts the deterministic properties the design promises: incremental rebuilds,
timestamp-free Merkle hashing, wiki-link rendering, and print_index output.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.llm_index import (
    FolderNote,
    LLMIndexer,
    MarkdownDocument,
)
from flow_sdk.llm_index.index_document import IndexDocument

FIXED_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
LATER_NOW = datetime(2026, 6, 3, tzinfo=timezone.utc)


def _summarize_file(doc, text):
    return f"summary of {doc.path.name}"


def _summarize_folder(item):
    return f"scope of {item.path.name}"


def _make_vault(root: Path) -> None:
    (root / "intro.md").write_text("# Intro\n\nWelcome.\n")
    (root / "pricing.md").write_text("# Pricing\n\nTiers.\n")
    auth = root / "auth"
    auth.mkdir()
    (auth / "oauth.md").write_text("# OAuth\n\nPKCE flow.\n")
    (auth / "tokens.md").write_text("# Tokens\n\nRefresh.\n")


# ── MarkdownDocument ──────────────────────────────────────────────────────────


def test_markdown_document_roundtrip():
    text = '---\ntitle: Hi\ncount: 3\nflag: true\ntags:\n  - a\n  - b\n---\n\n# Heading\n\nBody [[link]] here.\n'
    doc = MarkdownDocument.from_text(text)
    assert doc.get("title") == "Hi"
    assert doc.get("count") == 3
    assert doc.get("flag") is True
    assert doc.get("tags") == ["a", "b"]
    assert doc.title == "Heading"
    assert doc.wiki_links == ["link"]
    # round-trip frontmatter survives a parse → render → parse
    reparsed = MarkdownDocument.from_text(doc.render())
    assert reparsed.frontmatter == doc.frontmatter


def test_folder_note_detection(tmp_path: Path):
    note = tmp_path / "auth" / "auth.md"
    note.parent.mkdir()
    note.write_text("# Auth\n")
    assert FolderNote.is_folder_note(note)
    assert not FolderNote.is_folder_note(tmp_path / "auth" / "oauth.md")
    assert FolderNote.path_for(tmp_path / "auth") == note


# ── LLMIndexer rebuild ────────────────────────────────────────────────────────


def test_rebuild_creates_index_per_folder(tmp_path: Path):
    _make_vault(tmp_path)
    idx = LLMIndexer(tmp_path)
    stats = idx.rebuild(_summarize_file, _summarize_folder, now=FIXED_NOW)

    assert stats.folders_assembled == 2          # root + auth
    assert stats.files_summarised == 4
    assert (tmp_path / "index.md").is_file()
    assert (tmp_path / "auth" / "index.md").is_file()

    body = (tmp_path / "index.md").read_text()
    assert "## Files" in body
    assert "[[intro]]" in body                   # files are wiki-linked by stem
    assert "## Subfolders" in body
    assert "[[auth]]" in body                     # subfolder → child folder-note name


def test_rebuild_is_idempotent_and_timestamp_free(tmp_path: Path):
    _make_vault(tmp_path)
    LLMIndexer(tmp_path).rebuild(_summarize_file, _summarize_folder, now=FIXED_NOW)
    first = (tmp_path / "index.md").read_text()
    first_hash = IndexDocument.load(tmp_path).data.inputs_hash

    # Re-scan: nothing changed → no work, even with a different wall clock.
    stats2 = LLMIndexer(tmp_path).rebuild(_summarize_file, _summarize_folder, now=LATER_NOW)
    assert stats2.fresh
    assert (tmp_path / "index.md").read_text() == first
    assert IndexDocument.load(tmp_path).data.inputs_hash == first_hash


def test_incremental_only_touches_changed_chain(tmp_path: Path):
    _make_vault(tmp_path)
    LLMIndexer(tmp_path).rebuild(_summarize_file, _summarize_folder, now=FIXED_NOW)
    root_hash_before = IndexDocument.load(tmp_path).data.inputs_hash
    auth_hash_before = IndexDocument.load(tmp_path / "auth").data.inputs_hash

    # Edit one leaf file deep in the tree.
    (tmp_path / "auth" / "oauth.md").write_text("# OAuth\n\nNow with device flow.\n")

    idx = LLMIndexer(tmp_path)
    stale_folders = {i.path.name for i in idx.stale_indexes()}
    assert stale_folders == {tmp_path.name, "auth"}   # leaf folder + ancestor only

    stats = idx.rebuild(_summarize_file, _summarize_folder, now=LATER_NOW)
    assert stats.files_summarised == 1                 # only the edited file
    assert stats.folders_assembled == 2                # auth + root (the chain)

    # The Merkle chain moved; both hashes changed because content changed.
    assert IndexDocument.load(tmp_path / "auth").data.inputs_hash != auth_hash_before
    assert IndexDocument.load(tmp_path).data.inputs_hash != root_hash_before


def test_to_graph_nodes_and_child_edges(tmp_path: Path):
    _make_vault(tmp_path)
    graph = LLMIndexer(tmp_path).to_graph()

    # 2 folders (root + auth) + 4 files
    assert graph["counts"]["nodes"] == 6
    types = sorted(n["type"] for n in graph["nodes"])
    assert types == ["markdown", "markdown", "markdown", "markdown",
                     "markdown_index", "markdown_index"]
    for n in graph["nodes"]:
        assert n["key"] == f"{n['type']}-{n['id']}"

    child = [e for e in graph["edges"] if e["kind"] == "child"]
    # root→intro, root→pricing, root→auth, auth→oauth, auth→tokens
    assert len(child) == 5


def test_to_graph_resolves_wiki_link_edges(tmp_path: Path):
    _make_vault(tmp_path)
    # intro.md links to the oauth doc by stem
    (tmp_path / "intro.md").write_text("# Intro\n\nSee [[oauth]] for auth.\n")
    graph = LLMIndexer(tmp_path).to_graph()

    links = [e for e in graph["edges"] if e["kind"] == "context_shared"]
    assert len(links) == 1
    intro_id = next(n["id"] for n in graph["nodes"] if n["label"] == "Intro")
    oauth_id = next(n["id"] for n in graph["nodes"] if n["label"] == "OAuth")
    assert links[0]["from"]["id"] == intro_id
    assert links[0]["to"]["id"] == oauth_id


def test_scan_emits_progress_ticks(tmp_path: Path):
    _make_vault(tmp_path)
    ticks = []
    LLMIndexer(tmp_path, summaries_dir=tmp_path / ".cache").scan(on_tick=ticks.append)
    assert ticks  # at least one beat
    last = ticks[-1]
    assert last.folders_seen == 2
    assert last.files_seen == 4


def test_print_index_renders_tree(tmp_path: Path):
    _make_vault(tmp_path)
    idx = LLMIndexer(tmp_path)
    idx.rebuild(_summarize_file, _summarize_folder, now=FIXED_NOW)
    chart = LLMIndexer(tmp_path).print_index()
    assert "auth/" in chart
    assert "intro.md" in chart
    assert "├── " in chart or "└── " in chart
    assert "fresh" in chart                            # rebuilt → fresh
