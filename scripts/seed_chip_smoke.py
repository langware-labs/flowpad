"""Seed an AgenticProcess + context-entity entry for the chip 404-self-heal smoke.

Supports two entity types via ``--type {plan,markdown}`` (default ``plan``).
Each variant mirrors the original RCA flow inside the OSS dev instance so
the v1+v1.1+v1.2 fix can be validated end-to-end via Chrome MCP:

    1. Write a real .md to the layout the BE indexer expects (``~/.claude/
       plans/<slug>.md`` for plan, ``~/.claude/docs/<slug>.md`` for
       markdown), with a frontmatter ``id`` matching ``uuid5(NAMESPACE_URL,
       path)``.
    2. POST a fresh AgenticProcess to the OSS backend (default
       http://localhost:9008).
    3. POST ``share-context`` to link the entity, passing
       ``data={"path": <path>}`` so the AP's shared sidecar carries the path.
    4. DELETE the entity row from the active SQLite DB (default
       ``/tmp/flowpad_dev.db`` per ``.env.local``) to simulate "context
       references a typeid whose row isn't in the DB yet". The .md file
       stays on disk.
    5. Print the dock URL so the operator (or Chrome MCP) can click the
       chip. The expected outcome is the entity view rendering cleanly:
       the FE pre-warm hits the BE self-heal which single-file-indexes the
       file via the per-type registry, retries the lookup, returns 200.

Usage:

    uv run scripts/seed_chip_smoke.py                  # default: plan
    uv run scripts/seed_chip_smoke.py --type markdown  # gap-3 / v1.2

Requires the OSS BE on $LOCAL_SERVER_PORT (default 9008) and the OSS FE on
$VITE_PORT (default 4098) to be running.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx


LOCAL_URL = os.environ.get("LOCAL_BACKEND_URL", "http://localhost:9008").rstrip("/")
LOCAL_API = f"{LOCAL_URL}/api/v1"
FE_URL = os.environ.get("FE_URL", "http://localhost:4098").rstrip("/")

# The actual DB path the OSS BE writes to. Overridden by SQLITE_DATABASE_PATH
# in .env.local (default /tmp/flowpad_dev.db). The v1.1 script targeted
# ~/.flow/instances/oss/flowpad.db, which was wrong — DELETE silently
# matched nothing. /tmp/flowpad_dev.db is the right one in the dev config.
OSS_DB = Path(os.environ.get("SQLITE_DATABASE_PATH", "/tmp/flowpad_dev.db"))


@dataclass
class SeedSpec:
    """Per-type seed config: file layout + typeid wiring."""

    name: str                # 'plan' / 'markdown' — used in messages
    type_slug: str           # the type segment in the typeid (e.g. 'plan')
    subdir: Path             # path under ~/.claude/ (e.g. plans, docs)
    slug_prefix: str         # filename prefix

    @property
    def file_dir(self) -> Path:
        return Path.home() / ".claude" / self.subdir


SPECS: dict[str, SeedSpec] = {
    "plan": SeedSpec(
        name="plan", type_slug="plan", subdir=Path("plans"),
        slug_prefix="seed-chip-smoke",
    ),
    "markdown": SeedSpec(
        name="markdown", type_slug="markdown", subdir=Path("docs"),
        slug_prefix="seed-chip-smoke-md",
    ),
}


def _write_entity_file(spec: SeedSpec) -> tuple[Path, str]:
    """Create a fresh .md with deterministic id derived from its path."""
    spec.file_dir.mkdir(parents=True, exist_ok=True)
    slug = f"{spec.slug_prefix}-{uuid.uuid4().hex[:8]}"
    file_path = spec.file_dir / f"{slug}.md"
    entity_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(file_path.resolve())))
    body = (
        f"---\nid: \"{entity_id}\"\n---\n\n"
        f"# {slug}\n\n"
        "## Context\n\n"
        f"Seed {spec.name} for chip 404 self-heal smoke. The AP's context "
        f"entry carries a `path` sidecar so the dock loader can single-"
        f"file-index this {spec.name} when its DB row is missing.\n"
    )
    file_path.write_text(body, encoding="utf-8")
    return file_path, entity_id


def _post_agentic_process(http: httpx.Client, label: str) -> str:
    """Create a minimal AgenticProcess and return its id."""
    r = http.post(
        f"{LOCAL_API}/graph/agentic_process",
        json={"name": label, "workdir": str(Path.cwd())},
    )
    r.raise_for_status()
    eid = (r.json().get("data") or {}).get("id")
    if not eid:
        raise RuntimeError(f"AP create returned no id: {r.text}")
    return eid


def _share_with_path(
    http: httpx.Client, ap_id: str, type_slug: str, entity_id: str, file_path: Path,
) -> dict:
    r = http.post(
        f"{LOCAL_API}/graph/agentic_process/{ap_id}/share-context",
        json={
            "typeid": f"{type_slug}-{entity_id}",
            "data": {"path": str(file_path)},
        },
    )
    r.raise_for_status()
    return r.json().get("data") or {}


def _delete_entity_row(type_slug: str, entity_id: str) -> bool:
    """Drop the entity's DB row so the dock loader hits a real 404 and the
    self-heal path runs. The file on disk stays.

    Returns True if a row was deleted, False if no row existed."""
    if not OSS_DB.exists():
        raise RuntimeError(f"OSS DB not found at {OSS_DB}")
    conn = sqlite3.connect(str(OSS_DB))
    try:
        cur = conn.execute(
            "DELETE FROM entities WHERE type=? AND id=?", (type_slug, entity_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def _wait_for_be(http: httpx.Client, deadline_s: float = 5.0) -> None:
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            r = http.get(f"{LOCAL_URL}/api/v1/graph/bootstrap", timeout=1.0)
            if r.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"OSS backend not responding at {LOCAL_URL}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--type", "-t", choices=sorted(SPECS.keys()), default="plan",
        help="entity type to seed (default: plan)",
    )
    args = parser.parse_args()
    spec = SPECS[args.type]

    with httpx.Client(timeout=10.0) as http:
        _wait_for_be(http)

        file_path, entity_id = _write_entity_file(spec)
        print(f"[seed] wrote {spec.name} file: {file_path}")
        print(f"[seed] {spec.name}_id (uuid5 of path): {entity_id}")

        ap_id = _post_agentic_process(http, f"seed-chip-smoke {spec.name} AP")
        print(f"[seed] created AgenticProcess: {ap_id}")

        share_data = _share_with_path(http, ap_id, spec.type_slug, entity_id, file_path)
        sidecar = share_data.get("shared_context_entity_data", {})
        print(f"[seed] shared-context response sidecar: {sidecar}")
        expected_key = f"{spec.type_slug}-{entity_id}"
        if sidecar.get(expected_key, {}).get("path") != str(file_path):
            print("[seed] WARNING: round-tripped sidecar did not match expected path")

        dropped = _delete_entity_row(spec.type_slug, entity_id)
        print(f"[seed] {spec.name} row in DB removed: {dropped} (file kept on disk)")

        dock_url = f"{FE_URL}/dock/shell/agentic_process-{ap_id}?sideWindows=context"
        print()
        print("=" * 72)
        print(f"Navigate to: {dock_url}")
        print(f"Click the {spec.name.capitalize()} chip in the Shared Context panel.")
        print(f"Expected: {spec.name} view renders (no 'No {spec.name} file selected').")
        print(
            f"Expected network: GET /api/v1/graph/{spec.type_slug}/{entity_id}"
            "?hint_path=... → 200"
        )
        print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
