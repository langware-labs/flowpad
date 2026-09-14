"""Every walker that recurses a project tree applies one skip policy.

The asset consolidation (67fded8ce) introduced ``AssetFolder.scan`` beside the
indexer's ``gitignore_walk`` with its own skip rule, and a live worker rooted in
a checkout then classified its whole ``ui/node_modules`` on every get-assets
call. Both walkers run over the same checkout-shaped tree here and must agree
on which skill folders exist.
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.folder import AssetFolder, collect_assets
from flow_sdk.fs_store.indexer.walk import gitignore_walk
from tests.fixtures.checkout_tree import build_checkout_tree


def _skills_seen_by_gitignore_walk(root: Path) -> set[Path]:
    return {directory for directory, _dirs, files in gitignore_walk(root) if root / "SKILL.md" != directory and any(f.name == "SKILL.md" for f in files)}


def _skills_seen_by_asset_walker(root: Path) -> set[Path]:
    return {asset.path for asset in collect_assets([AssetFolder(path=root, recursive=True)]) if str(asset.typeid.type) == "skill"}


def test_asset_walker_and_indexer_walk_prune_the_same_checkout_dirs(tmp_path: Path) -> None:
    tree = build_checkout_tree(tmp_path / "checkout")
    expected = set(tree.visible)
    assert _skills_seen_by_gitignore_walk(tree.root) == expected
    assert _skills_seen_by_asset_walker(tree.root) == expected
    assert not (expected & set(tree.hidden))
