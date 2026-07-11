"""Benchmark the worker-history Claude collector: cold parse vs warm cache.

Builds a synthetic ``claude_projects_dir`` corpus in a tempdir (default
200 transcripts x 200 lines across 10 project dirs), points instance settings
at it, and times N sequential ``_collect_claude_entries_sync(limit, {})`` runs.
Run 1 is the cold fill (every candidate parses); later runs must hit the
persistent stats cache.

Acceptance: warm runs parse 0 files and complete in < 0.3s on this corpus.

Usage:
    uv run python scripts/bench_worker_history.py
    uv run python scripts/bench_worker_history.py --files 400 --lines 500 --runs 5
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def build_corpus(root: Path, n_files: int, n_lines: int, n_dirs: int) -> None:
    for i in range(n_files):
        proj = root / f"-Users-bench-proj-{i % n_dirs}"
        proj.mkdir(exist_ok=True)
        sid = f"{i:08d}-0000-4000-8000-000000000000"
        lines = [
            json.dumps({
                "parentUuid": None,
                "type": "user",
                "message": {"role": "user", "content": "benchmark prompt text " * 20 + f" line {j}"},
                "uuid": f"00000000-0000-4000-8000-{j:012d}",
                "timestamp": "2026-04-26T13:12:32.389Z",
                "cwd": f"/Users/bench/proj-{i % n_dirs}",
                "sessionId": sid,
                "version": "2.1.119",
                "gitBranch": "main",
            })
            for j in range(n_lines)
        ]
        (proj / f"{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", type=int, default=200)
    ap.add_argument("--lines", type=int, default=200)
    ap.add_argument("--dirs", type=int, default=10)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="bench-wh-") as td:
        root = Path(td)
        projects = root / "projects"
        projects.mkdir()
        t0 = time.time()
        build_corpus(projects, args.files, args.lines, args.dirs)
        print(f"corpus: {args.files} files x {args.lines} lines in {time.time() - t0:.1f}s")

        import flow_sdk.instance_settings as is_mod
        from flow_sdk.builtin import worker_history as wh
        from flow_sdk.fs_store.indexer.functions import claude_sessions as cs

        ns = SimpleNamespace(
            claude_projects_dir=projects,
            worker_history_cache_path=root / "wh_cache.sqlite",
        )
        is_mod.get_instance_settings = lambda: ns  # process-local override
        wh._build_history_latest_prompt_index = lambda: {}

        parse_counter = {"n": 0}
        real_extract = cs.extract_claude_session_from_path

        def counting_extract(*a, **k):
            parse_counter["n"] += 1
            return real_extract(*a, **k)

        cs.extract_claude_session_from_path = counting_extract

        warm_ok = True
        for run in range(1, args.runs + 1):
            parse_counter["n"] = 0
            t0 = time.time()
            rows = wh._collect_claude_entries_sync(args.limit, {})
            dt = time.time() - t0
            kind = "cold" if run == 1 else "warm"
            print(
                f"run {run} ({kind}): {dt * 1000:7.1f}ms  parsed={parse_counter['n']:4d}  rows={len(rows)}"
            )
            if run > 1 and (parse_counter["n"] != 0 or dt >= 0.3):
                warm_ok = False

        print()
        if warm_ok:
            print("ACCEPTANCE PASS: warm runs parsed 0 files in < 0.3s")
        else:
            print("ACCEPTANCE FAIL: a warm run parsed files or exceeded 0.3s")
            sys.exit(1)


if __name__ == "__main__":
    main()
