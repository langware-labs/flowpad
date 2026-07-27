"""Real running-app proof of git reflection — SINGLE instance, no hub/fanout.

Drives the actual gx7 backend over HTTP through the REAL pack→unpack path:
  1. Build a git repo with a NESTED skill; create the Skill row.
  2. Create a project-local conversation mapped to a fresh receiver project + add
     the skill as a message attachment (→ local FlowMessage).
  3. GET create-and-download-local-flowmsg  → the server packs the .flowmsg
     (real pack_bundle, with git_origins.json keyed by rel_path).
  4. POST flow-message-upload              → the server unpacks it (real
     unpack_bundle) into the receiver project.
  5. Assert the skill landed at <recv_proj>/<rel_path> (same repo path) and the
     materialized Skill row carries git_origin.

This exercises the same production functions the live app runs, end-to-end in a
real server process — independent of the (separately broken) cross-instance hub
fanout.

Run: BE=http://localhost:6007 EMAIL=gx7@local.test PW=gx7-pw-1234 \
     uv run python scripts/demo_git_origin_local.py
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

BE = os.environ.get("BE", "http://localhost:6007")
EMAIL = os.environ.get("EMAIL", "gx7@local.test")
PW = os.environ.get("PW", "gx7-pw-1234")
REL_PATH = "tools/kit/.claude/skills/foo"


def unwrap(r: httpx.Response):
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and "status" in j and j.get("status") != "SUCCESS":
        raise RuntimeError(f"{r.request.method} {r.request.url} -> {j}")
    return j.get("data") if isinstance(j, dict) else j


def post(c, path, body):
    return unwrap(c.post(f"{BE}/api/v1/{path.lstrip('/')}", json=body))


def get(c, path):
    return unwrap(c.get(f"{BE}/api/v1/{path.lstrip('/')}"))


def fail(m):
    print(f"\n❌ FAIL: {m}")
    sys.exit(2)


def git(root, *a):
    subprocess.run(["git", *a], cwd=root, check=True, capture_output=True, text=True)


def run() -> int:
    stamp = str(int(time.time()))
    base = Path(f"/tmp/gitref_local_{stamp}")
    repo = base / "repo"
    recv = base / "recv_proj"
    skill_dir = repo / REL_PATH
    skill_dir.mkdir(parents=True)
    recv.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(f"---\nname: foo-{stamp}\n---\n\n# foo\n", encoding="utf-8")
    git(repo, "init", "-q")
    git(repo, "remote", "add", "origin", f"https://github.com/Acme/Local-{stamp}.git")
    git(repo, "checkout", "-q", "-b", "feature/demo")
    git(repo, "config", "user.email", "t@t.co")
    git(repo, "config", "user.name", "t")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "init")

    with httpx.Client(timeout=60.0) as c:
        post(c, "cloud/login", {"email": EMAIL, "password": PW})
        print(f"· built repo {repo}; skill at {REL_PATH}")

        skill = post(c, "graph/skill", {"name": f"foo-{stamp}", "asset_ref": str(skill_dir)})
        skill_id = skill["id"]
        print(f"· skill skill-{skill_id}")

        proj = post(c, "graph/project", {"name": f"recv-{stamp}", "fs_storage_mount_path": str(recv)})
        conv = post(c, "graph/conversation", {"title": f"local-reflect {stamp}", "project_id": proj["id"]})
        conv_id = conv["id"]
        post(c, f"graph/conversation/{conv_id}/add_message",
             {"text": "skill", "asset_references": [f"skill-{skill_id}"]})

        # Resolve the FM id from the conversation's message pointers.
        from flow_sdk.fs_store.type_id import TypeId
        fm_id = None
        for _ in range(15):
            rc = get(c, f"graph/conversation/{conv_id}")
            mids = json.loads(rc.get("message_ids") or "[]")
            if mids:
                fm_id = TypeId(mids[0]["typeid"]).id
                break
            time.sleep(0.5)
        if not fm_id:
            fail("local FlowMessage was never created")
        print(f"· flow_message {fm_id} (project-local conversation {conv_id})")

        # 3. Server packs the .flowmsg (REAL pack_bundle).
        r = c.get(f"{BE}/api/v1/graph/flow_message/{fm_id}/create-and-download-local-flowmsg")
        r.raise_for_status()
        zip_bytes = r.content
        # Confirm the packed bundle carries git_origins.json keyed by rel_path.
        import zipfile
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()
            if "git_origins.json" not in names:
                fail("packed bundle missing git_origins.json")
            origins = json.loads(zf.read("git_origins.json"))
            key = f"skill-@{skill_id}"
            if origins.get(key, {}).get("rel_path") != REL_PATH:
                fail(f"git_origins.json rel_path wrong: {origins}")
        print(f"· server packed .flowmsg ({len(zip_bytes)} bytes); git_origins.json[{key}].rel_path={REL_PATH} ✓")

        # 4. Server unpacks it (REAL unpack_bundle) into the receiver project.
        files = {"file": (f"{fm_id}.flowmsg", zip_bytes, "application/zip")}
        ru = c.post(f"{BE}/api/v1/graph/flow-message-upload?overwrite=true", files=files)
        ru.raise_for_status()
        print(f"· server unpacked .flowmsg (upload status {ru.status_code})")

        # 5. Assert reflection: same repo-relative path + git_origin on the row.
        expected = recv / REL_PATH / "SKILL.md"
        ok = False
        for _ in range(10):
            if expected.exists():
                ok = True
                break
            time.sleep(0.5)
        print(f"· expected reconstructed path: {expected}")
        print(f"  exists: {expected.exists()}")
        if not ok:
            hits = [str(p) for p in recv.rglob("SKILL.md")]
            fail(f"skill did not reconstruct at the repo-relative path; found: {hits}")

        rskill = get(c, f"graph/skill/{skill_id}")
        go = (rskill or {}).get("git_origin")
        print(f"· skill row git_origin: {go}")
        if not go or go.get("rel_path") != REL_PATH or go.get("owner") != "Acme":
            fail(f"git_origin missing/incorrect: {go}")

    print("\n✅ PASS: git reflection reconstructs the same path through the REAL running backend "
          "(pack → unpack over HTTP), with git_origin stamped.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except httpx.HTTPError as e:
        fail(f"HTTP error: {e}")
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        fail(f"{type(e).__name__}: {e}")
