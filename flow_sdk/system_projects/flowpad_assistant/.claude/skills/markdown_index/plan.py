#!/usr/bin/env python3
"""plan.py — pure-Python planner for the `markdown_index` skill.

No LLM calls. No flowpad imports (so it can be run from any subagent context
without bootstrapping the SDK). Only stdlib.

Computes:
  * per-file content hashes for source `.md` files
  * per-folder `inputs_hash` = sha256 of
      template_version || prompt_version
      || sorted (name, content_hash) for direct source files
      || sorted (name, sha256(index.md_content)) for child folders' index.md
  * the stale-set:
      stale_files  — files whose summary cache is missing
      stale_folders_post_order — folders whose existing index.md frontmatter
        inputs_hash != recomputed inputs_hash, in post-order (leaves first)

Sub-commands:
  build <root> --summaries-dir <path> [--force]   JSON plan
  status <root> --summaries-dir <path>            one-line counts
  compute-hash <folder>                           one inputs_hash, no JSON wrapper
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

TEMPLATE_VERSION = 1
PROMPT_VERSION = 1
INDEX_FILENAME = "index.md"
IGNORE_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".tox", "dist", "build", ".eggs", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".next", ".nuxt", "coverage", ".cache",
    ".flowpad", ".markdown_index",
})
SOURCE_EXTS = frozenset({".md", ".mdx"})

# The summaries dir is supplied by the caller. The skill agent resolves the
# per-entity dir via flow_sdk and passes it as `--summaries-dir`. plan.py never
# invents a path of its own.


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter_inputs_hash(text: str) -> tuple[str, bool]:
    """Return (inputs_hash, manual_flag). Both default to ('', False)."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return "", False
    body = m.group(1)
    inputs_hash = ""
    manual = False
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("inputs_hash:"):
            val = line.split(":", 1)[1].strip()
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.startswith("'") and val.endswith("'"):
                val = val[1:-1]
            inputs_hash = val
        elif line.startswith("manual:"):
            val = line.split(":", 1)[1].strip().lower()
            manual = val in {"true", "yes", "1"}
    return inputs_hash, manual


def list_direct_source_files(folder: Path) -> list[Path]:
    """Direct (non-recursive) markdown source files in folder, excluding index.md."""
    out: list[Path] = []
    try:
        for entry in sorted(folder.iterdir()):
            if not entry.is_file():
                continue
            if entry.name == INDEX_FILENAME:
                continue
            if entry.suffix.lower() in SOURCE_EXTS:
                out.append(entry)
    except OSError:
        pass
    return out


def list_direct_subfolders(folder: Path) -> list[Path]:
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


def folders_post_order(root: Path) -> list[Path]:
    """DFS post-order: leaves before parents."""
    out: list[Path] = []

    def _visit(folder: Path) -> None:
        for sub in list_direct_subfolders(folder):
            _visit(sub)
        out.append(folder)

    _visit(root)
    return out


def compute_folder_inputs_hash(
    folder: Path,
    source_files: list[Path],
    file_hashes: dict[Path, str],
) -> str:
    h = hashlib.sha256()
    h.update(f"template_version={TEMPLATE_VERSION}\n".encode())
    h.update(f"prompt_version={PROMPT_VERSION}\n".encode())
    # Direct source files
    pairs = sorted(
        (f.name, file_hashes[f]) for f in source_files
    )
    for name, fh in pairs:
        h.update(b"file\0")
        h.update(name.encode("utf-8"))
        h.update(b"\0")
        h.update(fh.encode("utf-8"))
        h.update(b"\n")
    # Child index.md hashes
    child_pairs: list[tuple[str, str]] = []
    for sub in list_direct_subfolders(folder):
        idx = sub / INDEX_FILENAME
        if idx.exists() and idx.is_file():
            try:
                ch = sha256_bytes(idx.read_bytes())
            except OSError:
                continue
            child_pairs.append((sub.name, ch))
    for name, ch in sorted(child_pairs):
        h.update(b"child\0")
        h.update(name.encode("utf-8"))
        h.update(b"\0")
        h.update(ch.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def build_plan(root: Path, summaries_dir: Path, force: bool = False) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise SystemExit(f"not a directory: {root}")

    summaries_dir = summaries_dir.expanduser().resolve() if summaries_dir.exists() else summaries_dir.expanduser()

    file_hashes: dict[Path, str] = {}
    stale_files: list[dict[str, str]] = []
    stale_folders: list[dict] = []
    total_folders = 0
    total_files = 0

    post_order = folders_post_order(root)
    for folder in post_order:
        total_folders += 1
        source_files = list_direct_source_files(folder)
        for sf in source_files:
            total_files += 1
            try:
                fh = file_sha256(sf)
            except OSError:
                continue
            file_hashes[sf] = fh
            summary_path = summaries_dir / f"{fh}.summary.md"
            if force or not summary_path.exists():
                stale_files.append({
                    "path": str(sf),
                    "content_hash": fh,
                    "summary_path": str(summary_path),
                })

    # Folder post-order pass — must run AFTER all subfolders' index.md hashes
    # are computable. Since we walk in post-order, children are already
    # accounted for by the time we hit a parent.
    for folder in post_order:
        source_files = list_direct_source_files(folder)
        subfolders = list_direct_subfolders(folder)
        # Filter to subfolders with an index.md (others don't contribute)
        subfolders_with_index = [s for s in subfolders if (s / INDEX_FILENAME).is_file()]

        inputs_hash = compute_folder_inputs_hash(folder, source_files, file_hashes)

        existing_idx = folder / INDEX_FILENAME
        existing_hash = ""
        manual = False
        if existing_idx.exists():
            try:
                text = existing_idx.read_text(encoding="utf-8")
                existing_hash, manual = parse_frontmatter_inputs_hash(text)
            except OSError:
                pass

        if manual:
            continue  # respect hand-edited indexes
        if not force and existing_hash == inputs_hash and existing_hash:
            continue  # fresh

        stale_folders.append({
            "path": str(folder),
            "inputs_hash": inputs_hash,
            "existing_hash": existing_hash,
            "files": [
                {
                    "name": f.name,
                    "path": str(f),
                    "content_hash": file_hashes.get(f, ""),
                    "summary_path": str(summaries_dir / f"{file_hashes.get(f, '')}.summary.md"),
                }
                for f in source_files
                if f in file_hashes
            ],
            "subfolders": [
                {
                    "name": s.name,
                    "index_path": str(s / INDEX_FILENAME),
                }
                for s in subfolders_with_index
            ],
            "file_count": len(source_files),
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
    folder = folder.resolve()
    source_files = list_direct_source_files(folder)
    file_hashes: dict[Path, str] = {}
    for sf in source_files:
        try:
            file_hashes[sf] = file_sha256(sf)
        except OSError:
            pass
    return compute_folder_inputs_hash(folder, source_files, file_hashes)


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
