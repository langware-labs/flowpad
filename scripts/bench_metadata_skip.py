"""WHAT-IF: how much would mtime-skipping metadata.json writes save?

For each record under ~/.flow/records/claude_session/, compare the mtime of
the shadow metadata.json against the mtime of its source jsonl. Records
whose source hasn't been touched since the last index write are
"skip-eligible" — we'd avoid the disk write entirely.

Also samples the cost of an actual metadata.json write to extrapolate the
total savings.

No production code is changed.

Usage:
    uv run python scripts/bench_metadata_skip.py
"""

from __future__ import annotations

import json
import os
import statistics
import time
from pathlib import Path
from tempfile import NamedTemporaryFile


_FLOW_RECORDS = Path.home() / ".flow" / "records"
_CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def _record_source_for_session(record_dir: Path) -> Path | None:
    """Locate the source jsonl for a claude_session record dir.

    The record dir's metadata.json points at the jsonl via `path` or `source_file`.
    """
    md = record_dir / "metadata.json"
    if not md.exists():
        return None
    try:
        raw = json.loads(md.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    data = raw.get("data", raw) if isinstance(raw, dict) else raw
    p = data.get("path") or data.get("source_file") or data.get("jsonl_path")
    if not p:
        return None
    src = Path(p)
    return src if src.is_file() else None


def analyse_records(type_dir: Path) -> dict:
    """Return skip-eligible counts + size stats for a record-type dir."""
    if not type_dir.is_dir():
        return {"records": 0, "skip_eligible": 0, "needs_write": 0, "no_source": 0,
                "md_total_bytes": 0, "md_avg_bytes": 0, "type": type_dir.name}

    skip_eligible = 0
    needs_write = 0
    no_source = 0
    md_sizes: list[int] = []

    for record_dir in type_dir.iterdir():
        if not record_dir.is_dir():
            continue
        md = record_dir / "metadata.json"
        if not md.exists():
            continue
        try:
            md_stat = md.stat()
        except OSError:
            continue
        md_sizes.append(md_stat.st_size)

        # For claude_session, source is the jsonl referenced by metadata.json
        src = _record_source_for_session(record_dir)
        if src is None:
            no_source += 1
            continue
        try:
            src_stat = src.stat()
        except OSError:
            no_source += 1
            continue
        if md_stat.st_mtime >= src_stat.st_mtime:
            skip_eligible += 1
        else:
            needs_write += 1

    return {
        "type": type_dir.name,
        "records": len(md_sizes),
        "skip_eligible": skip_eligible,
        "needs_write": needs_write,
        "no_source": no_source,
        "md_total_bytes": sum(md_sizes),
        "md_avg_bytes": int(statistics.mean(md_sizes)) if md_sizes else 0,
        "md_p50_bytes": int(statistics.median(md_sizes)) if md_sizes else 0,
    }


def measure_metadata_write_cost(payload_size: int, n: int = 50) -> tuple[float, float]:
    """Time `n` realistic metadata.json writes to a tmpdir.

    Mirrors what `Record.save()` does: open + write + fsync. Returns (mean_ms, p50_ms).
    """
    payload = json.dumps({"data": {"x": "x" * (payload_size - 32)}}).encode()
    tmpdir = Path(_FLOW_RECORDS / "_bench_skip_tmp")
    tmpdir.mkdir(parents=True, exist_ok=True)
    samples: list[float] = []
    try:
        for i in range(n):
            target = tmpdir / f"metadata_{i}.json"
            t0 = time.perf_counter()
            with open(target, "wb") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            samples.append((time.perf_counter() - t0) * 1000)
        # Cleanup
        for f in tmpdir.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmpdir.rmdir()
        except OSError:
            pass
    except Exception:
        pass
    return (statistics.mean(samples) if samples else 0.0,
            statistics.median(samples) if samples else 0.0)


def fmt_bytes(b: int) -> str:
    for unit in ("B", "KB", "MB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} GB"


def main() -> None:
    if not _FLOW_RECORDS.is_dir():
        raise SystemExit(f"no records root at {_FLOW_RECORDS}")

    print(f"records root: {_FLOW_RECORDS}\n")

    # Per-record-type breakdown of skip-eligibility (only claude_session can
    # auto-detect source — others would need their own source-pointer logic).
    rows = []
    for type_dir in sorted(_FLOW_RECORDS.iterdir()):
        if type_dir.name in {"_bench_skip_tmp", "_archive"} or not type_dir.is_dir():
            continue
        # Only claude_session has a known source-file pointer (the jsonl path)
        if type_dir.name != "claude_session":
            continue
        rows.append(analyse_records(type_dir))

    print("== claude_session: skip eligibility on cold rebuild ==\n")
    print(f"  {'metric':<28} {'value':>10}")
    print(f"  {'-'*28} {'-'*10}")
    for r in rows:
        total = r["records"]
        eligible = r["skip_eligible"]
        needs = r["needs_write"]
        nosrc = r["no_source"]
        pct = 100 * eligible / total if total else 0
        print(f"  {'records on disk':<28} {total:>10,}")
        print(f"  {'skip-eligible (mtime ok)':<28} {eligible:>10,}")
        print(f"  {'needs write (source newer)':<28} {needs:>10,}")
        print(f"  {'no source pointer':<28} {nosrc:>10,}")
        print(f"  {'skip rate':<28} {pct:>9.1f}%")
        print(f"  {'avg metadata.json size':<28} {fmt_bytes(r['md_avg_bytes']):>10}")
        print(f"  {'median metadata.json size':<28} {fmt_bytes(r['md_p50_bytes']):>10}")
        print(f"  {'total metadata.json bytes':<28} {fmt_bytes(r['md_total_bytes']):>10}")

    # Now measure cost of a representative write
    if rows:
        avg_size = max(rows[0]["md_avg_bytes"], 512)
    else:
        avg_size = 2048
    print(f"\n== cost of one metadata.json write ({avg_size} B payload, fsync'd) ==\n")
    mean_ms, p50_ms = measure_metadata_write_cost(avg_size)
    print(f"  mean   = {mean_ms:.2f} ms")
    print(f"  median = {p50_ms:.2f} ms")

    # Extrapolate
    if rows:
        r = rows[0]
        eligible = r["skip_eligible"]
        needs = r["needs_write"] + r["no_source"]
        saved_ms = eligible * mean_ms
        kept_ms = needs * mean_ms
        total_ms = (eligible + needs) * mean_ms
        print(f"\n== extrapolated savings on cold rebuild ==\n")
        print(f"  current cost (all records)      : {total_ms:>8,.0f} ms  ({total_ms/1000:.1f} s)")
        print(f"  with mtime-skip (only newer)    : {kept_ms:>8,.0f} ms  ({kept_ms/1000:.1f} s)")
        print(f"  saved                            : {saved_ms:>8,.0f} ms  ({saved_ms/1000:.1f} s)")
        print(f"  reduction                        : {100 * saved_ms / total_ms:>7.1f}%")


if __name__ == "__main__":
    main()
