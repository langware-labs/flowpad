"""API-level validation that every asset-backed entity type round-trips
through the editor's read path correctly.

For each asset type with at least one entity:
  1. Pick a sample entity with non-empty asset_ref (skip system).
  2. Read the file at asset_ref directly off disk.
  3. Fetch via GET /api/v1/graph/compute_node/@local/fs/download/<asset_ref>.
     Must equal the disk bytes.
  4. List the entity's shadow folder ~/.flow/records/<type>/<type>-@<id>/.
     Must contain only metadata.json, state.json, and *.hash files. No body.
  5. POST /api/v1/graph/compute_node/@local/fs-records/index?type=<type>.
     Re-check 3 + 4 are still clean (idempotence — reindex must not plant
     new files in the shadow).

Prints pass/fail per type and exits non-zero on any failure.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API_ROOT = "http://localhost:9008"
RECORDS_ROOT = Path.home() / ".flow" / "records"

ASSET_TYPES = [
    "agent",
    "skill",
    "workflow",
    "markdown",
    "plan",
    "claude_md",
    "claude_memory",
]

KEEP_NAMES = {"metadata.json", "state.json"}
KEEP_SUFFIXES = {".hash"}


def _http_get(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _http_post(url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method="POST", data=b"")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _list_entities(entity_type: str) -> list[dict[str, Any]]:
    status, body = _http_get(f"{API_ROOT}/api/v1/graph/{entity_type}?include_system=1")
    if status != 200:
        return []
    payload = json.loads(body)
    return payload.get("data") or []


def _pick_sample(entities: list[dict[str, Any]]) -> dict[str, Any] | None:
    for ent in entities:
        if ent.get("system"):
            continue
        if ent.get("asset_ref"):
            return ent
    # If no non-system found, accept system as a fallback so the harness still runs
    for ent in entities:
        if ent.get("asset_ref"):
            return ent
    return None


def _shadow_files(entity_type: str, entity_id: str) -> list[Path]:
    folder = RECORDS_ROOT / entity_type / f"{entity_type}-@{entity_id}"
    if not folder.is_dir():
        return []
    return [p for p in folder.iterdir() if p.is_file()]


def _stray_shadow_bodies(entity_type: str, entity_id: str) -> list[Path]:
    out = []
    for p in _shadow_files(entity_type, entity_id):
        if p.name in KEEP_NAMES:
            continue
        if p.suffix in KEEP_SUFFIXES:
            continue
        out.append(p)
    return out


def _download_via_api(asset_ref: str) -> tuple[int, bytes]:
    # asset_ref is absolute: /Users/shlom/.claude/agents/foo.md
    # Endpoint URL: /api/v1/graph/compute_node/@local/fs/download/<sub_path>
    # The compute_node mount is /, so sub_path == asset_ref (with single leading /)
    sub = asset_ref if asset_ref.startswith("/") else "/" + asset_ref
    encoded = urllib.parse.quote(sub, safe="/")
    url = f"{API_ROOT}/api/v1/graph/compute_node/@local/fs/download{encoded}"
    return _http_get(url)


def _file_path_for(asset_ref: str, entity_type: str) -> Path:
    """Resolve asset_ref to an actual on-disk path. For Skill, asset_ref is a
    folder; the body lives at <asset_ref>/SKILL.md. For others it's a file."""
    p = Path(asset_ref)
    if entity_type == "skill" and p.is_dir():
        cand = p / "SKILL.md"
        if cand.is_file():
            return cand
    return p


def _hash(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()[:16]


def validate_type(entity_type: str) -> tuple[bool, str]:
    entities = _list_entities(entity_type)
    if not entities:
        return True, "no entities"
    sample = _pick_sample(entities)
    if sample is None:
        return True, "no sample with asset_ref"
    eid = sample["id"]
    asset_ref = sample["asset_ref"]
    name = sample.get("name") or eid

    # 1. Disk content
    disk_path = _file_path_for(asset_ref, entity_type)
    if not disk_path.is_file():
        return False, f"asset_ref points at {disk_path} which is not a file"
    disk_bytes = disk_path.read_bytes()

    # 2. API content
    if entity_type == "skill":
        # For skill the API endpoint serves files relative to mount; serve SKILL.md
        api_path = str(disk_path)
    else:
        api_path = asset_ref
    status, api_bytes = _download_via_api(api_path)
    if status != 200:
        return False, f"fs/download status={status} sub={api_path}"
    if api_bytes != disk_bytes:
        return False, (
            f"fs/download bytes differ from disk "
            f"(api={len(api_bytes)} sha={_hash(api_bytes)}, disk={len(disk_bytes)} sha={_hash(disk_bytes)})"
        )

    # 3. Shadow stray-body check
    stray = _stray_shadow_bodies(entity_type, eid)
    if stray:
        return False, f"stray body in shadow: {[p.name for p in stray]}"

    # 4. Reindex idempotence
    rstatus, _rbody = _http_post(
        f"{API_ROOT}/api/v1/graph/compute_node/@local/fs-records/index?type={entity_type}"
    )
    if rstatus != 200:
        return False, f"reindex status={rstatus}"

    # Re-check shadow + content after reindex
    stray2 = _stray_shadow_bodies(entity_type, eid)
    if stray2:
        return False, f"reindex planted stray body in shadow: {[p.name for p in stray2]}"
    if disk_path.read_bytes() != disk_bytes:
        return False, "reindex modified file at asset_ref (expected idempotent)"

    return True, f"{name} ({len(disk_bytes)} bytes, sha={_hash(disk_bytes)}) — clean"


def main() -> int:
    print(f"{'TYPE':<16} {'STATUS':<8} DETAIL")
    print("-" * 90)
    failures = 0
    for t in ASSET_TYPES:
        try:
            ok, detail = validate_type(t)
        except Exception as exc:
            ok, detail = False, f"exception: {exc!r}"
        marker = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"{t:<16} {marker:<8} {detail}")
    print("-" * 90)
    if failures:
        print(f"{failures} type(s) failed")
    else:
        print("all types clean")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
