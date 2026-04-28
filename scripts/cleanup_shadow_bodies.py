"""One-shot cleanup of stray body files in the records-root shadow tree.

Walks ~/.flow/records/<type>/<type>-@<id>/ and deletes every file whose name
is NOT one of: metadata.json, state.json, *.hash. This kills shadow .md/.json
copies that the old code path planted alongside metadata. Asset-backed
entities should hold body content only at entity.asset_ref (a user file under
~/.claude/, etc.).

Run AFTER the storage_driver mount-path fix and the AgentRecord/SkillRecord/
Record surgery. Run again later as a sanity sweep — should report zero deletes.

No prompts, no dry-run, no recovery. The user accepted that any record whose
shadow .md is the only copy of the body will lose that body.

Also nukes the CWD-mirror "phantom" trees created by the buggy LocalStorageDriver
on POSIX before today's storage_driver fix:
    /Users/shlom/Documents/dev/flowpad-oss/Users/
    /Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/Users/
"""

from __future__ import annotations

import os
import shutil
import sys
from collections import defaultdict
from pathlib import Path

KEEP_NAMES = {"metadata.json", "state.json"}
KEEP_SUFFIXES = {".hash"}

RECORDS_ROOT = Path.home() / ".flow" / "records"

PHANTOM_ROOTS = [
    Path("/Users/shlom/Documents/dev/flowpad-oss/Users"),
    Path("/Users/shlom/Documents/dev/flowpad-oss/flow_sdk/server/Users"),
    Path("/Users/shlom/Documents/dev/flowpad-app/Users"),
    Path("/Users/shlom/Documents/dev/flowpad-app/flow_sdk/server/Users"),
]


def is_keeper(name: str) -> bool:
    if name in KEEP_NAMES:
        return True
    suffix = Path(name).suffix
    if suffix in KEEP_SUFFIXES:
        return True
    return False


def cleanup_shadow() -> dict[str, dict[str, int]]:
    """Walk records-root, delete non-keeper files. Returns per-type counts."""
    counts: dict[str, dict[str, int]] = defaultdict(lambda: {"dirs": 0, "deleted": 0, "kept": 0})
    if not RECORDS_ROOT.is_dir():
        print(f"[shadow] records root not found: {RECORDS_ROOT}")
        return counts

    for type_dir in sorted(RECORDS_ROOT.iterdir()):
        if not type_dir.is_dir():
            continue
        type_name = type_dir.name
        for record_dir in type_dir.iterdir():
            if not record_dir.is_dir():
                continue
            counts[type_name]["dirs"] += 1
            try:
                entries = list(record_dir.iterdir())
            except OSError as exc:
                print(f"[shadow] {record_dir} unreadable: {exc}")
                continue
            for entry in entries:
                if not entry.is_file():
                    continue
                if is_keeper(entry.name):
                    counts[type_name]["kept"] += 1
                    continue
                try:
                    entry.unlink()
                    counts[type_name]["deleted"] += 1
                except OSError as exc:
                    print(f"[shadow] failed to delete {entry}: {exc}")
    return counts


def cleanup_phantoms() -> int:
    """Delete every CWD-mirror phantom tree. Returns total entries removed."""
    removed = 0
    for root in PHANTOM_ROOTS:
        if not root.exists():
            continue
        if not root.is_dir():
            continue
        try:
            shutil.rmtree(root)
            removed += 1
            print(f"[phantom] rm -rf {root}")
        except OSError as exc:
            print(f"[phantom] failed to remove {root}: {exc}")
    return removed


def main() -> int:
    print(f"[shadow] cleanup root: {RECORDS_ROOT}")
    counts = cleanup_shadow()
    print()
    print(f"{'TYPE':<22} {'DIRS':>6} {'DELETED':>8} {'KEPT':>6}")
    print("-" * 46)
    total_deleted = 0
    for t in sorted(counts):
        c = counts[t]
        print(f"{t:<22} {c['dirs']:>6} {c['deleted']:>8} {c['kept']:>6}")
        total_deleted += c["deleted"]
    print("-" * 46)
    print(f"{'TOTAL':<22} {sum(c['dirs'] for c in counts.values()):>6} {total_deleted:>8}")

    print()
    print("[phantom] removing CWD-mirror trees from the storage_driver mount-path bug:")
    phantom_removed = cleanup_phantoms()
    print(f"[phantom] {phantom_removed} root(s) removed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
