#!/usr/bin/env python3
"""plan.py — deterministic planner for the `markdown_index` skill.

No LLM calls. A thin CLI over :class:`flow_sdk.llm_index.LLMIndexer`, so the
skill and the server-side indexer (docs_graph routes) share ONE walking and
hashing engine: the gitignore-aware walk (dot-dirs included, ``.claude/``
force-included minus worktrees, ``.gitignore`` honored, flowpad state dirs
always skipped) and the content-derived Merkle ``inputs_hash`` from
``flow_sdk.llm_index.core`` (the old scheme that folded child ``index.md``
file bytes is retired — first run after this change re-assembles every
folder once; file summaries still cache-hit by content hash).

Requires ``flow_sdk`` importable — the skill's worker env guarantees this
(SKILL.md step 1 already imports flow_sdk to resolve the summaries dir).

Sub-commands:
  build <root> --summaries-dir <path> [--force]   JSON plan
  status <root> --summaries-dir <path>            one-line counts
  compute-hash <folder>                           one inputs_hash, no JSON wrapper

Note on ``compute-hash``: the folder is scanned as its own root, so a
``.gitignore`` in an *ancestor* directory is not loaded — results can differ
from a parent-rooted scan for gitignored corners.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from flow_sdk.llm_index import LLMIndexer
from flow_sdk.llm_index.core import PROMPT_VERSION, TEMPLATE_VERSION
from flow_sdk.llm_index.index_document import INDEX_FILENAME

# The summaries dir is supplied by the caller. The skill agent resolves the
# per-entity dir via flow_sdk and passes it as `--summaries-dir`. plan.py never
# invents a path of its own.


def build_plan(root: Path, summaries_dir: Path, force: bool = False) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")
    summaries_dir = summaries_dir.expanduser()
    if summaries_dir.exists():
        summaries_dir = summaries_dir.resolve()

    idx = LLMIndexer(root, summaries_dir=summaries_dir, force=force)

    total_folders = 0
    total_files = 0
    for item in idx.indexes():
        total_folders += 1
        total_files += len(item.files)

    stale_files = [
        {
            "path": str(doc.path),
            "content_hash": doc.content_hash,
            "summary_path": str(doc.summary_path),
        }
        for doc in idx.stale_docs()
    ]

    stale_folders: list[dict] = []
    for item in idx.stale_indexes():   # post-order, skips manual, honors force
        subfolders_with_index = [
            s for s in item.subfolders if (s.path / INDEX_FILENAME).is_file()
        ]
        stale_folders.append({
            "path": str(item.path),
            "inputs_hash": item.inputs_hash,
            "existing_hash": item.existing_hash,
            "files": [
                {
                    "name": doc.path.name,
                    "path": str(doc.path),
                    "content_hash": doc.content_hash,
                    "summary_path": str(doc.summary_path),
                }
                for doc in item.files
            ],
            "subfolders": [
                {
                    "name": s.path.name,
                    "index_path": str(s.path / INDEX_FILENAME),
                }
                for s in subfolders_with_index
            ],
            "file_count": len(item.files),
            "subfolder_count": len(subfolders_with_index),
        })

    return {
        "vault_root": str(root),
        "summaries_dir": str(summaries_dir),
        "template_version": TEMPLATE_VERSION,
        "prompt_version": PROMPT_VERSION,
        "stale_files": stale_files,
        "stale_folders_post_order": stale_folders,
        "total_folders": total_folders,
        "total_files": total_files,
    }


def status_line(plan: dict) -> str:
    return (
        f"folders={plan['total_folders']} "
        f"files={plan['total_files']} "
        f"stale_files={len(plan['stale_files'])} "
        f"stale_folders={len(plan['stale_folders_post_order'])} "
        f"vault={plan['vault_root']} "
        f"summaries={plan['summaries_dir']}"
    )


def compute_hash_only(folder: Path) -> str:
    idx = LLMIndexer(folder.resolve())
    root_item = next(item for item in idx.indexes() if item.rel_path == "")
    return root_item.inputs_hash


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="plan.py", description="markdown_index planner")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="produce the rebuild plan as JSON")
    p_build.add_argument("root", type=Path)
    p_build.add_argument("--summaries-dir", type=Path, required=True,
                         help="Absolute path to this entity's file-summaries dir "
                              "(resolved by the skill agent from the entity's id via "
                              "`flow_sdk.fs_store.operations.markdown_index.file_summaries_dir(entity_id)`).")
    p_build.add_argument("--force", action="store_true")

    p_status = sub.add_parser("status", help="one-line summary, no JSON")
    p_status.add_argument("root", type=Path)
    p_status.add_argument("--summaries-dir", type=Path, required=True)
    p_status.add_argument("--force", action="store_true")

    p_hash = sub.add_parser("compute-hash", help="print inputs_hash for one folder")
    p_hash.add_argument("folder", type=Path)

    args = parser.parse_args(argv)

    if args.cmd == "build":
        plan = build_plan(args.root, summaries_dir=args.summaries_dir, force=args.force)
        json.dump(plan, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    if args.cmd == "status":
        plan = build_plan(args.root, summaries_dir=args.summaries_dir, force=args.force)
        print(status_line(plan))
        return 0
    if args.cmd == "compute-hash":
        print(compute_hash_only(args.folder))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
