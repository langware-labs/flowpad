"""Unit tests for the pure-python flow_sdk.llm_index library.

No LLM, no DB, no server — drives LLMIndexer.rebuild() with stub summarizers and
asserts the deterministic properties the design promises: incremental rebuilds,
timestamp-free Merkle hashing, wiki-link rendering, and print_index output.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import json

from flow_sdk.llm_index import (
    FolderNote,
    LLMIndexer,
    MarkdownDocument,
    git_unified_diff,
    is_binary_bytes,
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
        assert "rel_path" in n
    rels = {n["rel_path"] for n in graph["nodes"]}
    assert {"", "auth", "intro.md", "auth/oauth.md"} <= rels

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


# ── stamp / status / change detection (real filesystem mutations) ────────────


def _statuses(graph: dict) -> dict[str, str]:
    return {n["rel_path"]: n["status"] for n in graph["nodes"]}


def test_stamp_then_real_fs_mutations_detected(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    _make_vault(vault)
    base = tmp_path / "data" / "baseline"

    LLMIndexer(vault, baseline_dir=base).stamp(now=FIXED_NOW)

    # Real fs mutations: modify, add, remove, rename.
    (vault / "intro.md").write_text("# Intro\n\nWelcome CHANGED.\n")
    (vault / "brand-new.md").write_text("# Brand New\n\nfresh\n")
    (vault / "pricing.md").unlink()
    moved = (vault / "auth" / "oauth.md").read_text()
    (vault / "auth" / "oauth.md").unlink()
    (vault / "auth" / "oauth-renamed.md").write_text(moved)

    idx = LLMIndexer(vault, baseline_dir=base)
    st = _statuses(idx.to_graph())
    assert st["intro.md"] == "modified"
    assert st["brand-new.md"] == "added"
    assert st["pricing.md"] == "removed"            # ghost
    assert st["auth/oauth-renamed.md"] == "added"   # graph-level (manifest pairs it)
    assert st["auth/oauth.md"] == "removed"
    assert st[""] == "stale" and st["auth"] == "stale"   # Merkle chain invalidated
    ghosts = {n["rel_path"] for n in idx.to_graph()["nodes"] if n["is_ghost"]}
    assert ghosts == {"pricing.md", "auth/oauth.md"}

    d = idx.diff_since_baseline()
    assert [m["rel"] for m in d["modified"]] == ["intro.md"]
    assert [a["rel"] for a in d["added"]] == ["brand-new.md"]
    assert [r["rel"] for r in d["removed"]] == ["pricing.md"]
    assert d["renamed"] == [{
        "from_rel": "auth/oauth.md", "to_rel": "auth/oauth-renamed.md",
        "content_hash": d["renamed"][0]["content_hash"],
    }]


def test_no_change_rescan_has_zero_false_positives(tmp_path: Path):
    _make_vault(tmp_path)
    base = tmp_path / ".data" / "baseline"
    s1 = LLMIndexer(tmp_path, baseline_dir=base).stamp(now=FIXED_NOW)
    assert s1.folders_stamped == 2

    idx = LLMIndexer(tmp_path, baseline_dir=base)
    st = _statuses(idx.to_graph())
    assert set(st.values()) == {"fresh"}
    d = idx.diff_since_baseline()
    assert all(not v for v in d.values())

    # Idempotent re-stamp, even with a different clock: nothing rewritten.
    s2 = LLMIndexer(tmp_path, baseline_dir=base).stamp(now=LATER_NOW)
    assert s2.folders_stamped == 0 and s2.folders_skipped == 2


def test_removed_folder_becomes_ghost_chain(tmp_path: Path):
    _make_vault(tmp_path)
    base = tmp_path / ".data" / "baseline"
    LLMIndexer(tmp_path, baseline_dir=base).stamp(now=FIXED_NOW)

    import shutil
    shutil.rmtree(tmp_path / "auth")

    idx = LLMIndexer(tmp_path, baseline_dir=base)
    graph = idx.to_graph()
    ghost_folders = [n for n in graph["nodes"] if n["is_ghost"] and n["type"] == "markdown_index"]
    assert [g["rel_path"] for g in ghost_folders] == ["auth"]
    # ghost folder is attached under the live root via a synthesized child edge
    gid = ghost_folders[0]["id"]
    assert any(e["kind"] == "child" and e["to"]["id"] == gid for e in graph["edges"])
    d = idx.diff_since_baseline()
    assert {r["rel"] for r in d["removed"]} == {"auth/oauth.md", "auth/tokens.md"}


def test_manual_folder_is_never_stamped_or_flagged(tmp_path: Path):
    _make_vault(tmp_path)
    (tmp_path / "auth" / "index.md").write_text("---\nmanual: true\n---\n\n# Hand-made\n")
    base = tmp_path / ".data" / "baseline"
    LLMIndexer(tmp_path, baseline_dir=base).stamp(now=FIXED_NOW)
    assert not (base / "auth" / "index.md.json").exists()

    idx = LLMIndexer(tmp_path, baseline_dir=base)
    assert _statuses(idx.to_graph())["auth"] == "manual"
    d = idx.diff_since_baseline()
    assert "auth" not in d["stale_folders"] and "auth" not in d["unindexed_folders"]


def test_blobs_written_size_guarded_and_gcd(tmp_path: Path):
    _make_vault(tmp_path)
    big = tmp_path / "big.md"
    big.write_text("# Big\n" + "x" * 100)
    base = tmp_path / ".data" / "baseline"

    idx = LLMIndexer(tmp_path, baseline_dir=base)
    idx.stamp(now=FIXED_NOW, max_blob_bytes=50)   # guard excludes big.md
    blobs = idx.blobs_dir
    big_hash = next(d.content_hash for d in LLMIndexer(tmp_path, baseline_dir=base).docs()
                    if d.path.name == "big.md")
    assert not (blobs / big_hash).exists()

    intro = LLMIndexer(tmp_path, baseline_dir=base).baseline_file("intro.md")
    old_blob = blobs / intro.content_hash
    assert old_blob.is_file()

    # Edit intro → re-stamp → new blob exists, orphaned old blob GC'd.
    (tmp_path / "intro.md").write_text("# Intro\n\nedited\n")
    s = LLMIndexer(tmp_path, baseline_dir=base).stamp(now=LATER_NOW, max_blob_bytes=50)
    assert s.blobs_deleted >= 1
    assert not old_blob.exists()
    new_ref = LLMIndexer(tmp_path, baseline_dir=base).baseline_file("intro.md")
    assert (blobs / new_ref.content_hash).is_file()


def test_legacy_demo_sidecar_degrades_to_unindexed(tmp_path: Path):
    """Regression pin: the old IndexMdJson schema (per-file rel_path/size_bytes,
    fake sha256:demo_* hashes, as in docs/index.md.json) must load as NO
    baseline — folder `unindexed`, zero `modified` — not as all-modified."""
    _make_vault(tmp_path)
    legacy = {
        "typeid": "markdown_index-x", "parent_ref": "", "vault_root": str(tmp_path),
        "folder_rel_path": "", "folder_name": tmp_path.name,
        "inputs_hash": "sha256:demo", "template_version": 1, "prompt_version": 1,
        "self_summary": "demo", "generated_at": "2026-05-24T00:00:00",
        "latest_process_ref": "", "schema_version": 1,
        "files": [{"name": "intro.md", "rel_path": "intro.md", "title": "Intro",
                   "summary": "demo", "content_hash": "sha256:demo_intro", "size_bytes": 1}],
        "subfolders": [],
    }
    (tmp_path / "index.md.json").write_text(json.dumps(legacy))

    idx = LLMIndexer(tmp_path, baseline_dir=tmp_path / ".data" / "baseline")
    st = _statuses(idx.to_graph())
    assert st[""] == "unindexed"
    assert st["intro.md"] == "unindexed"
    assert not any(s == "modified" for s in st.values())


def test_edges_carry_indexed_summaries(tmp_path: Path):
    """Tree edges expose the indexed one-liner (FileRef.summary / child
    self_summary) so the Atlas can render it along the connecting line."""
    _make_vault(tmp_path)
    base = tmp_path / ".data"
    idx = LLMIndexer(tmp_path, summaries_dir=base / "sums", baseline_dir=base / "baseline")
    for d in idx.docs():
        if d.path.name == "intro.md":
            d.set_summary("Getting-started walkthrough and install steps")
    idx.stamp(now=FIXED_NOW)

    g = LLMIndexer(
        tmp_path, summaries_dir=base / "sums", baseline_dir=base / "baseline"
    ).to_graph()
    with_summary = [e for e in g["edges"] if e["kind"] == "child" and e.get("summary")]
    assert len(with_summary) == 1
    assert with_summary[0]["summary"] == "Getting-started walkthrough and install steps"
    # edges without an indexed summary stay lean (no empty-string noise)
    assert sum(1 for e in g["edges"] if "summary" in e) == 1


def test_git_unified_diff_headers_and_crlf():
    d = git_unified_diff("a/b.md", "one\ntwo\n", "one\ntwo\nthree\n")
    assert d.splitlines()[0] == "diff --git a/a/b.md b/a/b.md"
    assert "+three" in d
    # CRLF vs LF same content → no false diff
    assert git_unified_diff("x.md", "one\r\ntwo\r\n", "one\ntwo\n") == ""
    assert is_binary_bytes(b"PK\x00\x01binary")
    assert not is_binary_bytes(b"plain text")


def test_print_index_renders_tree(tmp_path: Path):
    _make_vault(tmp_path)
    idx = LLMIndexer(tmp_path)
    idx.rebuild(_summarize_file, _summarize_folder, now=FIXED_NOW)
    chart = LLMIndexer(tmp_path).print_index()
    assert "auth/" in chart
    assert "intro.md" in chart
    assert "├── " in chart or "└── " in chart
    assert "fresh" in chart                            # rebuilt → fresh
