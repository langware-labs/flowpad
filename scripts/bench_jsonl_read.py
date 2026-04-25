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


def user_prompts_only(path: Path) -> int:
    """All user prompts (no assistant turns), full-file scan."""
    lines: list[str] = []
    with open(path, "rb") as fh:
        for raw in fh:
            if not raw.strip():
                continue
            try:
                e = orjson.loads(raw) if HAS_ORJSON else json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if e.get("type") != "user":
                continue
            msg = e.get("message") or {}
            t = _extract_text_current(msg.get("content") if isinstance(msg, dict) else None)
            if t:
                lines.append(t)
    return len(lines)


def first_user_only_full_scan(path: Path) -> int:
    """First user prompt only, but with full-file parse (worst-case for early-exit)."""
    found = None
    with open(path, "rb") as fh:
        for raw in fh:
            if not raw.strip():
                continue
            try:
                e = orjson.loads(raw) if HAS_ORJSON else json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if e.get("type") == "user" and found is None:
                msg = e.get("message") or {}
                t = _extract_text_current(msg.get("content") if isinstance(msg, dict) else None)
                if t:
                    found = t
    return 1 if found else 0


def first_user_only_early_exit(path: Path) -> int:
    """First user prompt only, stop reading after found."""
    with open(path, "rb") as fh:
        for raw in fh:
            if not raw.strip():
                continue
            try:
                e = orjson.loads(raw) if HAS_ORJSON else json.loads(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if e.get("type") == "user":
                msg = e.get("message") or {}
                t = _extract_text_current(msg.get("content") if isinstance(msg, dict) else None)
                if t:
                    return 1
    return 0


def head_tail_only(path: Path) -> int:
    """Read HEAD 4KB for first user prompt + TAIL 16KB for custom-title.

    Mirrors the cheap path used by from_jsonl() today.
    """
    HEAD = 4096
    TAIL = 16384
    found_user = 0
    custom_title = None
    try:
        with open(path, "rb") as fh:
            head = fh.read(HEAD)
        for line in head.split(b"\n"):
            if not line.strip():
                continue
            try:
                e = orjson.loads(line) if HAS_ORJSON else json.loads(line)
            except (ValueError, json.JSONDecodeError):
                break  # partial line at boundary
            if e.get("type") == "user":
                msg = e.get("message") or {}
                t = _extract_text_current(msg.get("content") if isinstance(msg, dict) else None)
                if t:
                    found_user = 1
                    break
        sz = path.stat().st_size
        with open(path, "rb") as fh:
            if sz > TAIL:
                fh.seek(sz - TAIL)
            tail = fh.read()
        for line in reversed(tail.split(b"\n")):
            if not line.strip():
                continue
            try:
                e = orjson.loads(line) if HAS_ORJSON else json.loads(line)
            except (ValueError, json.JSONDecodeError):
                continue
            if e.get("type") == "custom-title" and e.get("customTitle"):
                custom_title = e["customTitle"]
                break
    except OSError:
        pass
    return found_user + (1 if custom_title else 0)


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
    runs.append(("user prompts only (full scan, orjson)", user_prompts_only))
    runs.append(("first user only (full scan, orjson)", first_user_only_full_scan))
    runs.append(("first user only (early exit, orjson)", first_user_only_early_exit))
    runs.append(("head 4KB + tail 16KB (orjson)", head_tail_only))

    print(f"  {'approach':<48} {'best ms':>10} {'lines':>8} {'MB/s':>10}")
    print(f"  {'-' * 48} {'-' * 10} {'-' * 8} {'-' * 10}")
    for label, fn in runs:
        ms, n = bench(label, lambda fn=fn: fn(path))
        mbps = (sz / (1024 * 1024)) / (ms / 1000)
        print(f"  {label:<48} {ms:>10.2f} {n:>8} {mbps:>10.1f}")


if __name__ == "__main__":
    main()
