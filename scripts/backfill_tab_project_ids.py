#!/usr/bin/env python3
"""One-off backfill: re-resolve project_id for tabs that were minted projectless.

Root cause (fixed in ts_sdk/src/entities/tab.ts): Tab.getFromDockPointer resolved
the target entity with `dock.vfsPath.toString()` (absVfsPath, the
`compute_node-@local/...` form) instead of `.machinePath`. getEntityByPath matches
the stored MACHINE path, so the lookup returned null and the tab was persisted with
project_id=null — which makes it appear in EVERY project's tab strip.

This script talks ONLY over HTTP to the running backend (no direct SQLite access,
to avoid split-brain). For each projectless tab it replays the same resolution the
fixed FE now does, and PUTs back the corrected project_id when one is found.

Usage:  python3 scripts/backfill_tab_project_ids.py [BASE_URL] [--apply]
        (default BASE_URL=http://localhost:9007 ; omit --apply for a dry run)
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = "http://localhost:9007"
APPLY = "--apply" in sys.argv
for a in sys.argv[1:]:
    if a.startswith("http"):
        BASE = a.rstrip("/")

API = f"{BASE}/api/v1"
VFS_PREFIX = "compute_node-@local"


def _get(path, params=None):
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def _put(path, body):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def resolve_project_id(inner_pointer):
    """Mirror Tab.getFromDockPointer: a vfs dock resolves via machinePath; a
    typeid dock via the entity; a project target belongs to its own id."""
    # editor/<type>/vfs/compute_node-@local<machinePath>
    marker = f"/vfs/{VFS_PREFIX}"
    idx = inner_pointer.find(marker)
    if idx != -1:
        machine_path = inner_pointer[idx + len(marker):]
        if not machine_path:
            return None
        ent = _get("/assets/entity", {"path": machine_path}).get("data")
        return ent.get("project_id") if ent else None

    # editor/<type>/typeid/<type>-<id>
    if "/typeid/" in inner_pointer:
        tail = inner_pointer.split("/typeid/", 1)[1]
        # <type>-<uuid>  (uuid has 4 dashes; split off the last 5 dash groups)
        parts = tail.split("-")
        if len(parts) < 6:
            return None
        etype = "-".join(parts[:-5])
        eid = "-".join(parts[-5:])
        if etype == "project":
            return eid
        try:
            ent = _get(f"/graph/{etype}/{eid}").get("data")
        except Exception:
            return None
        return ent.get("project_id") if ent else None

    return None


def main():
    tabs = _get("/graph/tab/list_all")["data"]["tabs"]
    projectless = [t for t in tabs if t.get("project_id") is None]
    print(f"{len(tabs)} tabs total, {len(projectless)} projectless")

    updated = skipped = 0
    for t in projectless:
        try:
            outer = json.loads(t["pointer"])
        except Exception:
            skipped += 1
            continue
        inner = outer.get("pointer", "")
        pid = None
        try:
            pid = resolve_project_id(inner)
        except Exception as e:
            print(f"  ! resolve error {t['id']}: {e}")
        if not pid:
            skipped += 1
            print(f"  - skip  {t.get('name') or t['id']:<24} {inner[:60]}")
            continue
        print(f"  + scope {t.get('name') or t['id']:<24} -> {pid}  ({inner[:50]})")
        updated += 1
        if APPLY:
            body = dict(t)
            body["project_id"] = pid
            body.pop("status", None)  # runtime-only field, not persisted
            _put(f"/graph/tab/{t['id']}", body)

    mode = "APPLIED" if APPLY else "DRY RUN (re-run with --apply)"
    print(f"\n{mode}: {updated} re-scoped, {skipped} left projectless")


if __name__ == "__main__":
    main()
