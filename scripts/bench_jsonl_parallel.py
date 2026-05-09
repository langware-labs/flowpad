"""Benchmark sequential vs threaded vs process-pool JSONL parsing.

Picks N sessions from ~/.claude/projects and runs the same `_parse_fts`-style
workload over them. Useful to answer: does parallelizing claude_session
indexing actually help in Python?

Usage:
    uv run --with orjson python scripts/bench_jsonl_parallel.py [--limit 50]
"""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path

try:
    import orjson
    HAS_ORJSON = True
except ImportError:
    HAS_ORJSON = False


def _extract_text(content: object) -> str | None:
    if isinstance(content, str):
        text = content.strip()
        return text if text and not text.startswith("<") else None
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                return text if text and not text.startswith("<") else None
    return None


def _parse_fts_json(path: Path) -> tuple[str | None, str | None]:
    """stdlib-json equivalent of ClaudeSessionRecord._parse_fts()."""
    lines: list[str] = []
    last_title: str | None = None
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    e = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                etype = e.get("type")
                if etype == "custom-title":
                    ct = e.get("customTitle")
                    if ct:
                        last_title = ct
                    continue
                if etype not in ("user", "assistant"):
                    continue
                msg = e.get("message") or {}
                content = msg.get("content") if isinstance(msg, dict) else None
                t = _extract_text(content)
                if not t:
                    continue
                lines.append(f"{etype}: {t[:500]}")
    except OSError:
        return None, None
    return (last_title[:120] if last_title else None), "\n".join(lines) or None


def _parse_fts_orjson(path: Path) -> tuple[str | None, str | None]:
    """orjson equivalent — releases the GIL during parse."""
    lines: list[str] = []
    last_title: str | None = None
    try:
        with open(path, "rb") as fh:
            for raw in fh:
                if not raw.strip():
                    continue
                try:
                    e = orjson.loads(raw)
                except (orjson.JSONDecodeError, ValueError):
                    continue
                etype = e.get("type")
                if etype == "custom-title":
                    ct = e.get("customTitle")
                    if ct:
                        last_title = ct
                    continue
                if etype not in ("user", "assistant"):
                    continue
                msg = e.get("message") or {}
                content = msg.get("content") if isinstance(msg, dict) else None
                t = _extract_text(content)
                if not t:
                    continue
                lines.append(f"{etype}: {t[:500]}")
    except OSError:
        return None, None
    return (last_title[:120] if last_title else None), "\n".join(lines) or None


def discover_sessions(limit: int) -> list[Path]:
    base = Path.home() / ".claude" / "projects"
    files: list[Path] = []
    for d in base.iterdir():
        if not d.is_dir():
            continue
        for f in d.glob("*.jsonl"):
            files.append(f)
    # Largest first — exercises the slow path.
    files.sort(key=lambda p: -p.stat().st_size)
    return files[:limit]


def run_sequential(parser, files: list[Path]) -> int:
    return sum(1 for f in files if parser(f))


def run_threads(parser, files: list[Path], workers: int) -> int:
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return sum(1 for _ in ex.map(parser, files))


def run_processes(parser, files: list[Path], workers: int) -> int:
    with ProcessPoolExecutor(max_workers=workers) as ex:
        return sum(1 for _ in ex.map(parser, files))


def bench(label: str, fn, repeat: int = 2) -> float:
    best = float("inf")
    for _ in range(repeat):
        t = time.perf_counter()
        fn()
        ms = (time.perf_counter() - t) * 1000
        best = min(best, ms)
    return best


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50, help="number of sessions")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    files = discover_sessions(args.limit)
    if not files:
        raise SystemExit("no sessions found under ~/.claude/projects")
    total_bytes = sum(f.stat().st_size for f in files)
    print(f"sessions: {len(files)}    total: {total_bytes / 1024 / 1024:,.1f} MB")
    print(f"workers : {args.workers}\n")

    rows = []
    rows.append(("sequential — stdlib json", lambda: run_sequential(_parse_fts_json, files)))
    if HAS_ORJSON:
        rows.append(("sequential — orjson", lambda: run_sequential(_parse_fts_orjson, files)))
    rows.append(("threads — stdlib json", lambda: run_threads(_parse_fts_json, files, args.workers)))
    if HAS_ORJSON:
        rows.append(("threads — orjson", lambda: run_threads(_parse_fts_orjson, files, args.workers)))
    rows.append(("processes — stdlib json", lambda: run_processes(_parse_fts_json, files, args.workers)))
    if HAS_ORJSON:
        rows.append(("processes — orjson", lambda: run_processes(_parse_fts_orjson, files, args.workers)))

    print(f"  {'approach':<40} {'best ms':>10} {'ms/session':>12} {'MB/s':>10}")
    print(f"  {'-' * 40} {'-' * 10} {'-' * 12} {'-' * 10}")
    for label, fn in rows:
        ms = bench(label, fn)
        per = ms / len(files)
        mbps = (total_bytes / 1024 / 1024) / (ms / 1000)
        print(f"  {label:<40} {ms:>10.0f} {per:>12.1f} {mbps:>10.1f}")


if __name__ == "__main__":
    main()
