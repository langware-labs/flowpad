"""TreeHasher conformance — the Merkle doc tree (spec §9).

``scan_tree`` is the oracle: the values are its ``FolderNode`` tree, streamed
post-order.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.diskio.contract import FileNodeValue, FolderNodeValue, TreeHasher
from flow_sdk.diskio.python.tree_walker import walk_policy
from flow_sdk.llm_index.core import FolderNode, iter_folders_post_order, scan_tree
from tests.unit.diskio._backends import backends, drain, touch

EXTS = (".md", ".mdx")


@pytest.fixture(params=backends(TreeHasher))
def hasher(request):
    return request.param()


def scan(hasher, root: Path, *, gitignore: bool = True):
    body, _end = drain(hasher.scan_tree(str(root.resolve()), walk_policy(gitignore=gitignore, file_exts=EXTS)))
    return body


def folders(nodes) -> dict[str, FolderNodeValue]:
    return {node.rel_path: node for node in nodes if isinstance(node, FolderNodeValue)}


def files(nodes) -> dict[str, FileNodeValue]:
    return {node.rel_path: node for node in nodes if isinstance(node, FileNodeValue)}


def tree(root: Path) -> None:
    touch(root / "intro.md", "# Intro\n\nsee [[auth]] and [[setup|Setup]]\n")
    touch(root / "auth" / "auth.md", "# Auth\n")
    touch(root / "auth" / "login.md", "---\ntitle: Login Flow\n---\nno heading here\n")
    touch(root / "auth" / "tokens.mdx", "plain\n")
    touch(root / "auth" / "deep" / "x.md", "# X\n")
    touch(root / "auth" / "notes.txt", "not a source")
    touch(root / "node_modules" / "dep" / "readme.md", "# Dep\n")


def test_nodes_stream_post_order_and_end_with_the_root(hasher, tmp_path):
    tree(tmp_path)
    nodes = scan(hasher, tmp_path)
    order = [("folder" if isinstance(n, FolderNodeValue) else "file", n.rel_path) for n in nodes]
    assert order == [
        ("file", "auth/deep/x.md"), ("folder", "auth/deep"),
        ("file", "auth/auth.md"), ("file", "auth/login.md"), ("file", "auth/tokens.mdx"), ("folder", "auth"),
        ("file", "intro.md"), ("folder", ""),
    ]
    _body, end = drain(hasher.scan_tree(str(tmp_path.resolve()), walk_policy(file_exts=EXTS)))
    assert end.counts == {"diskio.file_node": 5, "diskio.folder_node": 3}


def test_titles_and_wiki_links(hasher, tmp_path):
    tree(tmp_path)
    found = files(scan(hasher, tmp_path))
    assert found["intro.md"].title == "Intro" and found["intro.md"].wiki_links == ("auth", "setup")
    assert found["auth/login.md"].title == "Login Flow", "no H1: the lenient frontmatter title"
    assert found["auth/tokens.mdx"].title == "tokens", "neither: the stem"


def test_the_folder_note_is_not_a_leaf_and_not_in_the_hash(hasher, tmp_path):
    tree(tmp_path)
    before = scan(hasher, tmp_path)
    auth = folders(before)["auth"]
    assert auth.folder_note == "auth/auth.md"
    assert auth.files == ("auth/login.md", "auth/tokens.mdx") and auth.subfolders == ("auth/deep",)
    assert files(before)["auth/auth.md"].is_folder_note is True

    (tmp_path / "auth" / "auth.md").write_text("# Auth, rewritten\n")
    after = scan(hasher, tmp_path)
    assert files(after)["auth/auth.md"].content_hash != files(before)["auth/auth.md"].content_hash
    assert folders(after)["auth"].own_hash == auth.own_hash
    assert folders(after)[""].inputs_hash == folders(before)[""].inputs_hash


def test_hashes_are_stable_across_runs(hasher, tmp_path):
    tree(tmp_path)
    assert scan(hasher, tmp_path) == scan(hasher, tmp_path)


def test_an_edit_changes_the_hash_up_to_the_root_and_nowhere_else(hasher, tmp_path):
    tree(tmp_path)
    touch(tmp_path / "other" / "o.md", "# O\n")
    before = folders(scan(hasher, tmp_path))
    (tmp_path / "auth" / "deep" / "x.md").write_text("# X, edited\n")
    after = folders(scan(hasher, tmp_path))
    assert after["auth/deep"].own_hash != before["auth/deep"].own_hash
    for rel in ("auth/deep", "auth", ""):
        assert after[rel].inputs_hash != before[rel].inputs_hash, rel
    assert after["auth"].own_hash == before["auth"].own_hash, "only a descendant changed"
    assert after["other"] == before["other"]


def test_index_md_is_read_for_its_flags_and_never_hashed(hasher, tmp_path):
    tree(tmp_path)
    before = folders(scan(hasher, tmp_path))
    assert (before["auth"].has_index, before["auth"].existing_hash, before["auth"].index_title) == (False, "", "")
    touch(tmp_path / "auth" / "index.md",
          f"---\ninputs_hash: {before['auth'].inputs_hash}\nmanual: true\n---\n# Auth index\n")
    after = folders(scan(hasher, tmp_path))["auth"]
    assert after.has_index is True and after.manual is True and after.ground_truth is False
    assert after.existing_hash == before["auth"].inputs_hash == after.inputs_hash
    assert after.index_title == "Auth index" and "auth/index.md" not in after.files


def test_a_dotfile_named_md_is_not_a_source(hasher, tmp_path):
    touch(tmp_path / ".md", "# hidden\n")
    touch(tmp_path / "a.md", "# A\n")
    assert folders(scan(hasher, tmp_path))[""].files == ("a.md",)


def test_the_walk_policy_decides_the_scope(hasher, tmp_path):
    tree(tmp_path)
    touch(tmp_path / ".gitignore", "auth/\n")
    assert set(folders(scan(hasher, tmp_path))) == {""}
    assert set(folders(scan(hasher, tmp_path, gitignore=False))) == {"", "auth", "auth/deep"}
    root = str(tmp_path.resolve())
    unlisted = walk_policy(gitignore=False, denylist=False, file_exts=EXTS)
    assert "node_modules/dep" in folders(drain(hasher.scan_tree(root, unlisted))[0])


@pytest.mark.parametrize("gitignore", [True, False])
def test_the_stream_is_scan_tree(hasher, tmp_path, gitignore):
    tree(tmp_path)
    touch(tmp_path / ".gitignore", "auth/deep/\n")
    touch(tmp_path / "auth" / "index.md", "---\ninputs_hash: stale\nground_truth: true\n---\n")
    nodes = scan(hasher, tmp_path, gitignore=gitignore)
    oracle: FolderNode = scan_tree(tmp_path, gitignore=gitignore)
    expected_folders = {
        f.rel_path: (tuple(n.rel_path for n in f.files), f.folder_note.rel_path if f.folder_note else None,
                     tuple(s.rel_path for s in f.subfolders), f.own_hash, f.inputs_hash, f.existing_hash,
                     f.manual, f.ground_truth, f.has_index, f.index_title)
        for f in iter_folders_post_order(oracle)
    }
    got = folders(nodes)
    assert list(got) == list(expected_folders), "post-order"
    assert {rel: (f.files, f.folder_note, f.subfolders, f.own_hash, f.inputs_hash, f.existing_hash,
                  f.manual, f.ground_truth, f.has_index, f.index_title) for rel, f in got.items()} == expected_folders
    expected_files = {
        n.rel_path: (n.content_hash, n.title, n.is_folder_note, tuple(n.wiki_links))
        for f in iter_folders_post_order(oracle)
        for n in (*f.files, *([f.folder_note] if f.folder_note else []))
    }
    assert {rel: (n.content_hash, n.title, n.is_folder_note, n.wiki_links)
            for rel, n in files(nodes).items()} == expected_files


def test_the_stream_fires_in_the_order_scan_tree_reports_progress(hasher, tmp_path):
    tree(tmp_path)
    seen: list[tuple[str, str]] = []
    root = tmp_path.resolve()
    scan_tree(tmp_path, on_node=lambda path, kind: seen.append((kind, "" if path == root else str(path.relative_to(root)))))
    nodes = scan(hasher, tmp_path)
    assert [("folder" if isinstance(n, FolderNodeValue) else "file", n.rel_path) for n in nodes] == seen
