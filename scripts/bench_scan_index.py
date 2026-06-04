"""Benchmark scan + index end-to-end with per-type timing.

Usage:
    uv run python scripts/bench_scan_index.py
    uv run python scripts/bench_scan_index.py --rebuild   # archive + clear first

Reads `SQLITE_DATABASE_PATH` from the environment; defaults to the repo's
dev DB. Prints a scan-phase breakdown (per-type ref counts) and an
index-phase breakdown (per-type indexed + skipped + duration_ms).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import time
from collections import Counter
from pathlib import Path


async def main(rebuild: bool) -> None:
    # Ensure fs_records auto-register before we ask the indexer for types.
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401
    from flow_sdk.db import get_db_driver
    from flow_sdk.fs_store.indexer.builtin import INDEXABLE_TYPES, get_shared_indexer
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions

    indexer = get_shared_indexer()
    driver = get_db_driver()

    if rebuild:
        print("=== rebuild: clearing indexable types ===")
        t0 = time.perf_counter()
        for rt in INDEXABLE_TYPES:
            await driver.delete_entities_by_type(str(rt))
        await driver.fts_clear()
        print(f"  cleared in {(time.perf_counter() - t0) * 1000:.1f} ms\n")

    # --- Scan ---
    print("=== scan ===")
    t0 = time.perf_counter()
    refs = await indexer.scan(IndexerOptions(verbose=False))
    scan_ms = (time.perf_counter() - t0) * 1000

    type_counts = Counter(str(r.record_type) for r in refs if r.record_type)
    print(f"  total: {len(refs)} refs in {scan_ms:,.1f} ms ({scan_ms / max(len(refs), 1):.2f} ms/ref)\n")
    print(f"  {'type':<38} {'count':>8}")
    print(f"  {'-' * 38} {'-' * 8}")
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"  {t:<38} {c:>8}")

    # --- Index ---
    print("\n=== index ===")
    t0 = time.perf_counter()
    result = await indexer.index(IndexerOptions(verbose=False))
    wall_ms = (time.perf_counter() - t0) * 1000

    reported_ms = sum(pt.duration_ms for pt in result.per_type.values())
    print(
        f"  total: {result.total_indexed:,} indexed, {result.total_errors} errors — "
        f"wall {wall_ms:,.1f} ms (per-type sum {reported_ms:,.1f} ms)\n"
    )
    print(f"  {'type':<38} {'indexed':>8} {'skipped':>8} {'errors':>6} {'ms':>10} {'ms/rec':>9}")
    print(f"  {'-' * 38} {'-' * 8} {'-' * 8} {'-' * 6} {'-' * 10} {'-' * 9}")
    for rt, pt in sorted(result.per_type.items(), key=lambda x: -x[1].duration_ms):
        processed = pt.indexed or 1
        per = pt.duration_ms / processed
        print(
            f"  {str(rt):<38} {pt.indexed:>8} {pt.skipped:>8} {pt.errors:>6} {pt.duration_ms:>10,.1f} {per:>9.2f}"
        )


def _parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Benchmark scan + index phases.")
    ap.add_argument("--rebuild", action="store_true", help="Clear indexable types first (forces full reindex).")
    ap.add_argument("--db", help="Override SQLITE_DATABASE_PATH for this run.")
    return ap.parse_args()


if __name__ == "__main__":
    args = _parse()
    if args.db:
        os.environ["SQLITE_DATABASE_PATH"] = args.db
    elif "SQLITE_DATABASE_PATH" not in os.environ:
        env_local = Path(__file__).resolve().parent.parent / ".env.local"
        if env_local.exists():
            for line in env_local.read_text().splitlines():
                if line.startswith("SQLITE_DATABASE_PATH="):
                    os.environ["SQLITE_DATABASE_PATH"] = line.split("=", 1)[1].strip()
                    break
    db_path = os.environ.get("SQLITE_DATABASE_PATH", "<default>")
    print(f"SQLITE_DATABASE_PATH={db_path}\n")
    asyncio.run(main(args.rebuild))
