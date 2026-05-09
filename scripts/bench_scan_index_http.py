"""Benchmark scan + index via the HTTP system-tools endpoints.

Mirrors `bench_scan_index.py` but goes through the same routes the UI uses,
so you can compare in-process indexer vs the full HTTP path.

Usage:
    uv run python scripts/bench_scan_index_http.py
    uv run python scripts/bench_scan_index_http.py --rebuild
    uv run python scripts/bench_scan_index_http.py --base-url http://localhost:9008
"""

from __future__ import annotations

import argparse
import os
import time
import urllib.request
import urllib.error
import json
from collections import OrderedDict
from pathlib import Path


def _request(base_url: str, method: str, path: str, timeout: int = 600) -> dict:
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _resolve_base_url(arg: str | None) -> str:
    if arg:
        return arg.rstrip("/")
    if "LOCAL_SERVER_PORT" in os.environ:
        return f"http://localhost:{os.environ['LOCAL_SERVER_PORT']}"
    env_local = Path(__file__).resolve().parent.parent / ".env.local"
    if env_local.exists():
        for line in env_local.read_text().splitlines():
            if line.startswith("LOCAL_SERVER_PORT="):
                return f"http://localhost:{line.split('=', 1)[1].strip()}"
    return "http://localhost:9008"


def main(rebuild: bool, base_url: str) -> None:
    archive_path = "/api/v1/graph/compute_node/@local/desktop-db/archive"
    clear_path = "/api/v1/graph/compute_node/@local/desktop-db/clear-index"
    scan_path = "/api/v1/graph/compute_node/@local/fs-records/scan?trigger=manual"
    index_path = "/api/v1/graph/compute_node/@local/fs-records/index"

    if rebuild:
        print("=== rebuild: archive + clear-index (HTTP) ===")
        t0 = time.perf_counter()
        _request(base_url, "POST", archive_path)
        archive_ms = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        _request(base_url, "POST", clear_path)
        clear_ms = (time.perf_counter() - t0) * 1000
        print(f"  archive={archive_ms:,.1f} ms   clear-index={clear_ms:,.1f} ms\n")

    # --- Scan ---
    print("=== scan (HTTP /fs-records/scan?trigger=manual) ===")
    t0 = time.perf_counter()
    scan_resp = _request(base_url, "GET", scan_path)
    wall_ms = (time.perf_counter() - t0) * 1000
    sd = scan_resp.get("data") or {}
    server_ms = sd.get("scan_ms") or 0.0
    types = sd.get("types") or []
    grand_total = sd.get("grand_total") or 0
    print(f"  wall {wall_ms:,.1f} ms (server-reported scan_ms {server_ms:,.1f}) — {grand_total} refs\n")
    types_sorted = sorted(types, key=lambda t: -t.get("count", 0))
    print(f"  {'type':<38} {'count':>8} {'bytes':>14}")
    print(f"  {'-' * 38} {'-' * 8} {'-' * 14}")
    for t in types_sorted:
        print(f"  {t['type']:<38} {t['count']:>8} {t['total_bytes']:>14,}")

    # --- Index ---
    print("\n=== index (HTTP POST /fs-records/index) ===")
    t0 = time.perf_counter()
    idx_resp = _request(base_url, "POST", index_path)
    wall_ms = (time.perf_counter() - t0) * 1000
    idx = idx_resp.get("data") or {}
    indexed = idx.get("indexed", 0)
    errors = idx.get("errors", 0)
    duration_ms = idx.get("duration_ms", 0.0)
    types_out = idx.get("types") or []
    print(
        f"  wall {wall_ms:,.1f} ms (server-reported duration_ms {duration_ms:,.1f}) — "
        f"{indexed:,} indexed, {errors} errors\n"
    )
    by_dur = sorted(types_out, key=lambda t: -t.get("duration_ms", 0))
    print(f"  {'type':<38} {'indexed':>8} {'errors':>6} {'ms':>10} {'ms/rec':>9}")
    print(f"  {'-' * 38} {'-' * 8} {'-' * 6} {'-' * 10} {'-' * 9}")
    for t in by_dur:
        idx_n = t.get("indexed", 0) or 1
        per = t.get("duration_ms", 0) / idx_n
        print(f"  {t['type']:<38} {t.get('indexed', 0):>8} {t.get('errors', 0):>6} {t.get('duration_ms', 0):>10,.1f} {per:>9.2f}")


def _parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Benchmark scan + index via HTTP system-tools endpoints.")
    ap.add_argument("--rebuild", action="store_true", help="Archive + clear-index first (full reindex).")
    ap.add_argument("--base-url", help="Backend base URL (default: from .env.local LOCAL_SERVER_PORT).")
    return ap.parse_args()


if __name__ == "__main__":
    args = _parse()
    base_url = _resolve_base_url(args.base_url)
    print(f"backend={base_url}\n")
    try:
        main(args.rebuild, base_url)
    except urllib.error.URLError as e:
        raise SystemExit(f"backend not reachable at {base_url}: {e}")
