#!/usr/bin/env python3
"""docs_index_report.py — the no-LLM audit behind `docit index fast`.

Formats what the library already knows into the four answers a rebuild decision
needs: which folders have no ``index.md``, which existing ``index.md`` files are
hand-written and would be CLOBBERED by a rebuild, what a rebuild would cost in
LLM calls, and which folders are deliberately protected.

Every fact comes from :class:`flow_sdk.llm_index.LLMIndexer` — the same walk,
Merkle hashing and staleness the server routes and the `markdown_index` skill
use. This script owns only the formatting, and writes nothing.

Usage:
    python3 .claude/skills/docit/scripts/docs_index_report.py [<root>]
    python3 .claude/skills/docit/scripts/docs_index_report.py [<root>] --print-summaries-dir

``<root>`` defaults to ``docs``. ``--print-summaries-dir`` prints the resolved
cache path and exits — so callers never re-derive it (it is FLOW_INSTANCE-scoped,
and a divergent copy silently resolves an EMPTY cache, whose only symptom is a
full-price re-summarisation of the whole tree).
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _load_env() -> None:
    """Resolve the instance the way the backend does — BEFORE importing flow_sdk.

    Entry points load ``.env.local``; libraries only read env (instance
    resolution is env-only by design). ``run.py`` does exactly this with
    ``override=True``, and matching it is load-bearing: this checkout pins
    ``FLOW_INSTANCE=oss``, so a script that skips the load falls back to
    ``prod`` and reports on — or warms — a summary cache the running app never
    reads. ``FLOWPAD_SKIP_DOTENV`` opts out, same as the backend.
    """
    if os.environ.get("FLOWPAD_SKIP_DOTENV", "").lower() == "true":
        return
    try:
        from dotenv import find_dotenv, load_dotenv
    except ImportError:
        return
    env_file = find_dotenv(os.getenv("ENV", ".env.local"))
    if env_file:
        load_dotenv(env_file, override=True)


_load_env()

from flow_sdk.fs_store.operations.markdown_index import summaries_dir_for_root  # noqa: E402
from flow_sdk.llm_index import LLMIndexer  # noqa: E402
from flow_sdk.llm_index.index_document import INDEX_FILENAME  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="docs_index_report.py")
    ap.add_argument("root", nargs="?", default="docs")
    ap.add_argument("--print-summaries-dir", action="store_true",
                    help="print the resolved summary-cache path and exit")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    summaries_dir = summaries_dir_for_root(root)
    if args.print_summaries_dir:
        print(summaries_dir)
        return 0

    idx = LLMIndexer(root, summaries_dir=summaries_dir)

    missing: list[str] = []          # no index.md on disk
    stale: list[str] = []            # generated index.md, hash drifted
    would_clobber: list[str] = []    # hand-written index.md, unprotected
    protected: list[str] = []        # ground_truth: true / manual: true
    folders = files = 0

    for item in idx.indexes():
        folders += 1
        files += len(item.files)
        label = item.rel_path or "."

        if item.is_protected:
            flag = "ground_truth" if item.is_ground_truth else "manual"
            protected.append(f"{label}  ({flag})")
        elif not item.has_index:
            missing.append(f"{label}  ({len(item.files)}f/{len(item.subfolders)}d)")
        elif not item.is_generator_authored:
            would_clobber.append(f'{label}/{INDEX_FILENAME}  "{item.index_title}"')
        elif item.is_stale:
            stale.append(label)

    # Same predicate `plan.py` builds its `stale_files` list from, so the estimate
    # below is the planner's own count rather than a second definition of it.
    uncached = sum(1 for _ in idx.stale_docs())

    print(f"root={root}")
    print(f"folders={folders} files={files} uncached={uncached} "
          f"missing={len(missing)} stale={len(stale)} "
          f"would_clobber={len(would_clobber)} protected={len(protected)}")
    print(f"summaries_dir={summaries_dir}"
          f"{'' if summaries_dir.is_dir() else '  (does not exist yet)'}")

    for heading, rows in (
        ("MISSING (no index.md)", missing),
        ("STALE (hash drifted)", stale),
        ("WOULD CLOBBER (hand-written, unprotected — add `ground_truth: true`)",
         would_clobber),
        ("PROTECTED (generator stays out)", protected),
    ):
        if rows:
            print(f"\n{heading}:")
            for row in rows:
                print(f"  {row}")

    print()
    if not (missing or stale or would_clobber):
        print(f"INDEX FRESH ({folders} folders, 0 stale)")
    else:
        print(f"INDEX STALE: {len(missing)} missing, {len(stale)} stale, "
              f"{uncached} uncached, {len(would_clobber)} would-clobber")
        if would_clobber:
            print("`index full` is unsafe until the would-clobber list is resolved.")
    # A fresh chain can still have a cold cache, so this is not part of the verdict.
    if uncached:
        print(f"`index full` would make ~{uncached} file-summary LLM calls.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
