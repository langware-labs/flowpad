"""Baseline: how fast can Python load + iterate a JSONL file?

Compares the realistic top-of-Python paths so we know the floor
for any indexer optimisation.

Usage:
    uv run python scripts/bench_jsonl_read.py <path-to-jsonl>
    uv run python scripts/bench_jsonl_read.py ~/.claude/projects/<dir>/<id>.jsonl
"""

from __future__ import annotations

import json
import mmap
import sys
import time
from pathlib import Path

try:
    import orjson
    HAS_ORJSON = True
except ImportError:
    HAS_ORJSON = False


def bench(label: str, fn, repeat: int = 3) -> tuple[float, int]:
    best_ms = float("inf")
    n = 0
    for _ in range(repeat):
        t0 = time.perf_counter()
        n = fn()
        ms = (time.perf_counter() - t0) * 1000
        if ms < best_ms:
            best_ms = ms
    return best_ms, n


def lines_iter_text(path: Path) -> int:
    n = 0
    with open(path, encoding="utf-8") as fh:
        for _ in fh:
            n += 1
    return n


def lines_iter_binary(path: Path) -> int:
    n = 0
    with open(path, "rb") as fh:
        for _ in fh:
            n += 1
    return n


def lines_readall_split(path: Path) -> int:
    return path.read_bytes().count(b"\n")


def lines_mmap(path: Path) -> int:
    n = 0
    with open(path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        for _ in iter(mm.readline, b""):
            n += 1
    return n


def parse_json_text(path: Path) -> int:
    n = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                json.loads(line)
                n += 1
    return n


def parse_json_binary(path: Path) -> int:
    n = 0
    with open(path, "rb") as fh:
        for line in fh:
            if line.strip():
                json.loads(line)
                n += 1
    return n


def parse_orjson_binary(path: Path) -> int:
    n = 0
    with open(path, "rb") as fh:
        for line in fh:
            if line.strip():
                orjson.loads(line)
                n += 1
    return n


def parse_orjson_mmap(path: Path) -> int:
    n = 0
    with open(path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        for line in iter(mm.readline, b""):
            if line.strip():
                orjson.loads(line)
                n += 1
    return n


def _extract_text_current(content: object) -> str | None:
    """Mirror of flow_sdk/fs_records/claude/claude_session.py:_extract_text."""
    if isinstance(content, str):
        text = content.strip()
        return text if text and not text.startswith("<") else None
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "").strip()
                return text if text and not text.startswith("<") else None
    return None


def current_parse_fts(path: Path) -> int:
    """Replicates ClaudeSessionRecord._parse_fts() — what the indexer runs today."""
    lines: list[str] = []
    last_custom_title: str | None = None
    with open(path, encoding="utf-8") as fh:
        for raw_line in fh:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            try:
                entry = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            etype = entry.get("type")
            if etype == "custom-title":
                ct = entry.get("customTitle")
                if ct:
                    last_custom_title = ct
                continue
            if etype not in ("user", "assistant"):
                continue
            msg = entry.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else None
            text = _extract_text_current(content)
            if not text:
                continue
            if etype == "user":
                lines.append(f"user: {text}")
            else:
                lines.append(f"assistant: {text[:500]}")
    title = last_custom_title[:120] if last_custom_title else None  # noqa: F841
    return len(lines)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: bench_jsonl_read.py <path-to-jsonl>")
    path = Path(sys.argv[1]).expanduser()
    sz = path.stat().st_size
    print(f"file: {path}")
    print(f"size: {sz / 1024:,.1f} KB ({sz / (1024 * 1024):,.2f} MB)\n")

    runs = [
        ("for line in open(text)            (no parse)", lines_iter_text),
        ("for line in open('rb')             (no parse)", lines_iter_binary),
        ("read_bytes().count(b'\\n')          (no parse)", lines_readall_split),
        ("mmap.readline                      (no parse)", lines_mmap),
        ("text + json.loads                  (parsed)", parse_json_text),
        ("'rb'  + json.loads                 (parsed)", parse_json_binary),
    ]
    if HAS_ORJSON:
        runs.append(("'rb'  + orjson.loads               (parsed)", parse_orjson_binary))
        runs.append(("mmap  + orjson.loads               (parsed)", parse_orjson_mmap))
    runs.append(("CURRENT _parse_fts() (text+json+extract)", current_parse_fts))

    print(f"  {'approach':<48} {'best ms':>10} {'lines':>8} {'MB/s':>10}")
    print(f"  {'-' * 48} {'-' * 10} {'-' * 8} {'-' * 10}")
    for label, fn in runs:
        ms, n = bench(label, lambda fn=fn: fn(path))
        mbps = (sz / (1024 * 1024)) / (ms / 1000)
        print(f"  {label:<48} {ms:>10.2f} {n:>8} {mbps:>10.1f}")


if __name__ == "__main__":
    main()
