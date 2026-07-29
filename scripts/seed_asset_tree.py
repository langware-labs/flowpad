#!/usr/bin/env python3
"""Seed the asset-menu fixture tree into a real directory, for browser checks.

Builds the same layout ``tests/unit/test_project_asset_menu_indexed.py`` asserts
on — a project with a git-backed context folder over a ``file://`` origin plus
three levels of nested context-folder projects — so what you click through in the
UI is exactly what the test pins.

    FLOW_INSTANCE=dev-1 uv run python scripts/seed_asset_tree.py /tmp/menu-demo

Indexing writes identity capsules (``.flow/``, frontmatter ``id:``) back into the
files it just wrote, so the target directory is a required argument with no
default, and a non-empty one is refused unless you pass --force.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.fixtures.asset_tree import build_asset_tree  # noqa: E402


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("base", type=Path, help="directory to build the tree in (required)")
    ap.add_argument("--force", action="store_true", help="build into a non-empty directory")
    ap.add_argument("--no-index", action="store_true", help="write files only; create nothing in the DB")
    args = ap.parse_args()

    tree = await build_asset_tree(args.base.expanduser().resolve(), index=not args.no_index, force=args.force)
    print(f"tree: {tree.base}")
    for key in tree.node_keys():
        spec = tree.spec(key)
        own = ", ".join(f"{t}={n}" for t, n in sorted(tree.expected_own(key).items())) or "-"
        total = ", ".join(f"{t}={n}" for t, n in sorted(tree.expected_total(key).items())) or "-"
        print(f"  {key:<6} {spec.kind:<8} {tree.path(key)}\n         own[{own}]  total[{total}]")
    if tree.projects:
        print(f"\nproject: {tree.projects['P'].id}")
        print(f"open:    /dock/project/{tree.projects['P'].id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
