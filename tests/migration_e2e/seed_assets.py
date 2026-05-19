#!/usr/bin/env python3
"""Seed user assets on the OLD flowpad version (0.2.25).

Writes minimal valid records of a few entity types directly to disk,
then runs ``flow record index`` to register them with the indexer.
Records the created IDs + names to /tmp/seeded_ids.json so
verify_post_migration.sh can confirm they survive the upgrade.

Container runs as the **dev** instance (FLOWPAD_DEV=true on OLD,
FLOW_INSTANCE=dev on NEW), so the legacy on-disk layout uses the
``dev_`` prefix. The migration script copies ``dev_records/`` →
``instances/dev/records/`` and the new version's InstanceSettings
points at the new location.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SEEDED_IDS_PATH = Path("/tmp/seeded_ids.json")
FLOW_HOME = Path(os.environ.get("FLOW_HOME") or (Path.home() / ".flow"))
# OLD 0.2.25 in dev mode writes records under ``dev_records/``.
LEGACY_RECORDS_ROOT = FLOW_HOME / "dev_records"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def seed_markdown(name: str) -> dict:
    rec_id = uuid.uuid4().hex
    folder = LEGACY_RECORDS_ROOT / "markdown" / f"markdown-@{rec_id}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text(json.dumps({
        "data": {
            "id": rec_id,
            "type": "markdown",
            "name": name,
            "status": "ready",
            "created_date": _now_iso(),
            "updated_date": _now_iso(),
        }
    }, indent=2))
    (folder / "content.md").write_text(f"# {name}\n\nSeeded by migration e2e test.\n")
    return {"id": rec_id, "type": "markdown", "name": name, "folder": str(folder)}


def seed_task(name: str) -> dict:
    rec_id = uuid.uuid4().hex
    folder = LEGACY_RECORDS_ROOT / "task" / f"task-@{rec_id}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text(json.dumps({
        "data": {
            "id": rec_id,
            "type": "task",
            "name": name,
            "status": "TODO",
            "description": "Seeded by migration e2e test.",
            "created_date": _now_iso(),
            "updated_date": _now_iso(),
        }
    }, indent=2))
    (folder / "state.json").write_text(json.dumps({"status": "TODO"}, indent=2))
    return {"id": rec_id, "type": "task", "name": name, "folder": str(folder)}


def seed_project(name: str) -> dict:
    rec_id = uuid.uuid4().hex
    folder = LEGACY_RECORDS_ROOT / "project" / f"project-@{rec_id}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text(json.dumps({
        "data": {
            "id": rec_id,
            "type": "project",
            "name": name,
            "status": "active",
            "created_date": _now_iso(),
            "updated_date": _now_iso(),
        }
    }, indent=2))
    return {"id": rec_id, "type": "project", "name": name, "folder": str(folder)}


def index_folder(folder: str, type_name: str) -> dict:
    result = subprocess.run(
        ["flow", "record", "index", folder, "--types", type_name],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        print(f"  ! flow record index failed for {folder}", file=sys.stderr)
        print(f"    stdout: {result.stdout}", file=sys.stderr)
        print(f"    stderr: {result.stderr}", file=sys.stderr)
        raise SystemExit(2)
    # CLI may print non-JSON preamble; pick the last line that parses.
    for line in reversed(result.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    print(f"  ! no JSON output from flow record index", file=sys.stderr)
    print(f"    raw: {result.stdout}", file=sys.stderr)
    raise SystemExit(2)


def main() -> int:
    LEGACY_RECORDS_ROOT.mkdir(parents=True, exist_ok=True)
    seeded: list[dict] = []
    suffix = uuid.uuid4().hex[:8]

    print(f"=== Seeding assets under {LEGACY_RECORDS_ROOT} (suffix={suffix}) ===")
    for fn, name in [
        (seed_markdown, f"e2e-doc-{suffix}"),
        (seed_task, f"e2e-task-{suffix}"),
        (seed_project, f"e2e-project-{suffix}"),
    ]:
        rec = fn(name)
        out = index_folder(rec["folder"], rec["type"])
        total = out.get("total_indexed", out.get("data", {}).get("total_indexed", 0))
        print(f"  ✓ {rec['type']:10s} {rec['name']} → indexed (total_indexed={total})")
        rec.pop("folder", None)
        seeded.append(rec)

    SEEDED_IDS_PATH.write_text(json.dumps(seeded, indent=2))
    print(f"=== Wrote {len(seeded)} seeded records to {SEEDED_IDS_PATH} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
