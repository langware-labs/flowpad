#!/usr/bin/env python3
"""Standalone project discovery + index script.

Mirrors exactly what SchemaRegistry.discover(types=["project"]) does during a
full rebuild, but runs as a standalone script so you can inspect the numbers
without starting the full server.

Usage:
    uv run scripts/scan_projects.py           # dry-run: discover only (no DB write)
    uv run scripts/scan_projects.py --index   # discover + write to DB
    uv run scripts/scan_projects.py --fix     # also fix the count/iter mismatch bug
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

# Allow running from repo root without installing
sys.path.insert(0, str(Path(__file__).parent.parent))


_CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
_TEMP_PATH_PREFIXES = ("/tmp/", "/var/folders/", "/private/var/folders/", "/private/tmp/")


# ---------------------------------------------------------------------------
# Phase 1 — raw filesystem scan (no imports needed)
# ---------------------------------------------------------------------------

def scan_raw() -> dict:
    """Scan ~/.claude/projects/ directly, show count vs iter discrepancy."""
    if not _CLAUDE_PROJECTS_DIR.is_dir():
        return {"error": f"{_CLAUDE_PROJECTS_DIR} does not exist"}

    all_dirs: list[Path] = [d for d in sorted(_CLAUDE_PROJECTS_DIR.iterdir()) if d.is_dir()]

    def is_temp(d: Path) -> bool:
        real = "/" + d.name.lstrip("-").replace("-", "/")
        return real.startswith(_TEMP_PATH_PREFIXES)

    temp_dirs = [d for d in all_dirs if is_temp(d)]
    non_temp_dirs = [d for d in all_dirs if not is_temp(d)]

    return {
        "total_dirs": len(all_dirs),
        "_external_source_count_result": len(non_temp_dirs),  # what count() returns
        "_external_source_iter_result": len(all_dirs),         # what iter() yields
        "temp_paths_included_in_iter": len(temp_dirs),
        "temp_path_examples": [d.name[:60] for d in temp_dirs[:5]],
        "non_temp_examples": [d.name[:60] for d in non_temp_dirs[:5]],
    }


# ---------------------------------------------------------------------------
# Phase 2 — SDK-level discover_iter (uses ClaudeProjectFsRecord)
# ---------------------------------------------------------------------------

def discover_via_sdk(verbose: bool = False) -> dict:
    """Use the actual SDK discover_iter() — mirrors what indexing iterates."""
    from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord

    t0 = time.perf_counter()

    count_from_count_method = ClaudeProjectFsRecord.discovery_items_count()
    count_from_iter = 0
    temp_in_iter = 0

    for rec in ClaudeProjectFsRecord.discover_iter():
        count_from_iter += 1
        real_path = rec.data.get("real_path", "")
        if real_path.startswith(_TEMP_PATH_PREFIXES):
            temp_in_iter += 1
            if verbose:
                print(f"  [temp] {real_path}")

    elapsed_ms = (time.perf_counter() - t0) * 1000

    return {
        "discovery_items_count()": count_from_count_method,
        "discover_iter() yielded": count_from_iter,
        "temp paths in iter": temp_in_iter,
        "discrepancy": count_from_iter - count_from_count_method,
        "scan_ms": round(elapsed_ms, 1),
    }


# ---------------------------------------------------------------------------
# Phase 3 — full index (writes to DB)
# ---------------------------------------------------------------------------

async def index_via_sdk(dry_run: bool = True) -> dict:
    """Run the same index_type flow as SchemaRegistry.discover()."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.fs_store.record_types import RecordType

    if dry_run:
        # Just scan, no DB writes
        scan_results, _ = await SchemaRegistry.discover(
            types=[RecordType.PROJECT],
            trigger="script",
            actions=["scan"],
        )
        sr = scan_results[0] if scan_results else None
        return {
            "mode": "scan-only (dry run)",
            "scanned": sr.count if sr else 0,
            "scan_ms": round(sr.scan_ms, 1) if sr else 0,
        }
    else:
        # Full scan + index (writes to DB)
        from flow_sdk.db import init_db
        await init_db()
        scan_results, index_results = await SchemaRegistry.discover(
            types=[RecordType.PROJECT],
            trigger="rebuild",
            actions=["scan", "index"],
        )
        sr = scan_results[0] if scan_results else None
        ir = index_results[0] if index_results else None
        return {
            "mode": "scan + index",
            "scanned": sr.count if sr else 0,
            "indexed": ir.indexed if ir else 0,
            "skipped": ir.skipped if ir else 0,
            "errors": ir.errors if ir else 0,
            "scan_ms": round(sr.scan_ms, 1) if sr else 0,
            "index_ms": round(ir.duration_ms, 1) if ir else 0,
        }


# ---------------------------------------------------------------------------
# Fix: align _external_source_iter with _external_source_count filtering
# ---------------------------------------------------------------------------

def show_fix_diff():
    """Print the one-line fix for the count/iter mismatch."""
    print("\n[BUG] _external_source_iter does not filter temp paths but _external_source_count does.")
    print("[FIX] Add the same _keep() guard to _external_source_iter:\n")
    print("""  @classmethod
  def _external_source_iter(cls, limit: int | None = None):
      projects_dir = _CLAUDE_PROJECTS_DIR
      if not projects_dir.is_dir():
          return
      count = 0
      for d in sorted(projects_dir.iterdir()):
          if not d.is_dir():
              continue
+         real = "/" + d.name.lstrip("-").replace("-", "/")
+         if real.startswith(_TEMP_PATH_PREFIXES):
+             continue
          yield cls._from_claude_dir(d)
          count += 1
          if limit is not None and count >= limit:
              return
""")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _print_section(title: str, data: dict):
    width = 60
    print(f"\n{'─' * width}")
    print(f"  {title}")
    print(f"{'─' * width}")
    for k, v in data.items():
        if isinstance(v, list):
            print(f"  {k}:")
            for item in v:
                print(f"    - {item}")
        else:
            print(f"  {k:<45} {v}")


def main():
    parser = argparse.ArgumentParser(description="Project discovery + index script")
    parser.add_argument("--index", action="store_true", help="Write to DB (default: dry-run)")
    parser.add_argument("--verbose", action="store_true", help="Print temp path names")
    parser.add_argument("--fix", action="store_true", help="Show the code fix for the bug")
    args = parser.parse_args()

    print("=" * 60)
    print("  Project Discovery & Index Audit")
    print("=" * 60)

    # Phase 1: raw filesystem scan
    raw = scan_raw()
    _print_section("Phase 1 — Raw filesystem scan (~/.claude/projects/)", raw)

    # Phase 2: SDK discover_iter
    print("\n  Running SDK discover_iter()... (may take a moment)")
    sdk = discover_via_sdk(verbose=args.verbose)
    _print_section("Phase 2 — SDK discover_iter() vs discovery_items_count()", sdk)

    # Phase 3: index
    print("\n  Running SDK index flow...")
    result = asyncio.run(index_via_sdk(dry_run=not args.index))
    _print_section("Phase 3 — SchemaRegistry.discover(types=['project'])", result)

    if args.fix or sdk.get("discrepancy", 0) != 0:
        show_fix_diff()

    print("\n" + "=" * 60)


if __name__ == "__main__":
    main()
