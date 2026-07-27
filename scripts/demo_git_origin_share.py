"""E2E: git reflection — a skill that lives at a NESTED repo path is shared from
gx7 → gx8 and must land on the receiver at the SAME repo-relative path (not the
flattened canonical .claude/skills/<name>), with the receiver entity carrying a
``git_origin``.

Real running backends (instance_ctl gx7/gx8) + the local hub. Drives the same
HTTP the UI does.

Run:
  SENDER_BE=http://localhost:6007 RECV_BE=http://localhost:6008 \
  SENDER_EMAIL=gx7@local.test SENDER_PW=gx7-pw-1234 \
  RECV_EMAIL=gx8@local.test RECV_PW=gx8-pw-1234 \
  uv run python scripts/demo_git_origin_share.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093")
SENDER_BE = os.environ.get("SENDER_BE", "http://localhost:6007")
RECV_BE = os.environ.get("RECV_BE", "http://localhost:6008")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "gx7@local.test")
SENDER_PW = os.environ.get("SENDER_PW", "gx7-pw-1234")
RECV_EMAIL = os.environ.get("RECV_EMAIL", "gx8@local.test")
RECV_PW = os.environ.get("RECV_PW", "gx8-pw-1234")
ROUNDS = int(os.environ.get("SYNC_ROUNDS", "25"))
SLEEP = float(os.environ.get("SYNC_SLEEP", "1.0"))

REL_PATH = "tools/kit/.claude/skills/foo"  # the NESTED repo-relative path we expect reconstructed


def _unwrap(r: httpx.Response) -> Any:
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and "status" in j and j.get("status") != "SUCCESS":
        raise RuntimeError(f"{r.request.method} {r.request.url} -> {j}")
    return j.get("data") if isinstance(j, dict) else j


def post(c, be, path, body):
    return _unwrap(c.post(f"{be}/api/v1/{path.lstrip('/')}", json=body))


def get(c, be, path):
    return _unwrap(c.get(f"{be}/api/v1/{path.lstrip('/')}"))


def fail(msg):
    print(f"\n❌ FAIL: {msg}")
    sys.exit(2)


def until(pred):
    for i in range(ROUNDS):
        try:
            if pred():
                return True
        except Exception as e:  # noqa: BLE001
            print(f"    (round {i}: {e})")
        time.sleep(SLEEP)
    return False


def git(root, *args):
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def run() -> int:
    stamp = str(int(time.time()))
    base = Path(f"/tmp/gitref_{stamp}")
    sender_repo = base / "sender_repo"
    recv_proj = base / "recv_proj"
    skill_dir = sender_repo / REL_PATH
    recv_proj.mkdir(parents=True, exist_ok=True)

    with httpx.Client(timeout=40.0) as c:
        print("· step 1: login both instances (local + hub)")
        post(c, SENDER_BE, "cloud/login", {"email": SENDER_EMAIL, "password": SENDER_PW})
        post(c, RECV_BE, "cloud/login", {"email": RECV_EMAIL, "password": RECV_PW})
        rb = c.post(f"{HUB}/api/v1/login", json={"email": RECV_EMAIL, "password": RECV_PW})
        rb.raise_for_status()
        recv_tok = rb.json()["data"].get("api_key") or rb.json()["data"].get("token")

        print("· step 2: sender builds a git repo with a NESTED skill")
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(f"---\nname: foo-{stamp}\n---\n\n# foo skill\n", encoding="utf-8")
        git(sender_repo, "init", "-q")
        git(sender_repo, "remote", "add", "origin", f"https://github.com/Acme/Reflect-{stamp}.git")
        git(sender_repo, "checkout", "-q", "-b", "feature/demo")
        git(sender_repo, "config", "user.email", "t@t.co")
        git(sender_repo, "config", "user.name", "t")
        git(sender_repo, "add", "-A")
        git(sender_repo, "commit", "-qm", "init")
        print(f"    repo {sender_repo}  skill at {REL_PATH}")

        # Sender project backed by the repo root, then index the skill from disk.
        sproj = post(c, SENDER_BE, "graph/project", {"name": f"reflect-src-{stamp}",
                                                     "fs_storage_mount_path": str(sender_repo)})
        sender_pid = sproj["id"]
        print(f"    sender project {sender_pid}")
        # Create the Skill row pointing at the on-disk folder (same pattern the
        # markdown demo uses for a file-backed asset). pack resolves asset_ref →
        # the folder → GitOrigin.for_asset_path computes its repo-relative path.
        skill = post(c, SENDER_BE, "graph/skill", {
            "name": f"foo-{stamp}",
            "asset_ref": str(skill_dir),
        })
        skill_id = skill["id"]
        skill_ref = f"skill-{skill_id}"
        print(f"    skill {skill_ref}  asset_ref={skill.get('asset_ref')}")

        print("· step 3: sender creates+shares a conversation, then SENDS the skill as a message attachment")
        conv = post(c, SENDER_BE, "graph/conversation", {
            "title": f"git-reflect {stamp}",
            "project_id": sender_pid,
        })
        conv_id = conv["id"]
        post(c, SENDER_BE, f"graph/conversation/{conv_id}/share", {**conv, "recipients": [RECV_EMAIL]})
        # The skill rides as a MESSAGE ATTACHMENT → packed into the body bundle
        # (where git reflection lives), NOT as conversation shared_context (which
        # would route hub-hosted with no rel_path).
        post(c, SENDER_BE, f"graph/conversation/{conv_id}/add_message", {
            "text": "Here is the skill from my repo",
            "asset_references": [skill_ref],
        })
        print(f"    conversation {conv_id} shared to {RECV_EMAIL}; skill sent as attachment")
        import json as _json
        # NOTE: Conversation.add_message goes straight to the hub and the fanout
        # SKIPS the sender, so the sender's LOCAL message_ids stays empty — don't
        # gate on it. The body uploads to the hub asynchronously; the receiver's
        # HTTP conversation-message-sync (below) pulls it once ready (no WS needed).

        print("· step 4: receiver accepts the invitation")
        def accept():
            r = c.get(f"{HUB}/api/v1/graph/invitation/pending", headers={"Authorization": f"Bearer {recv_tok}"})
            r.raise_for_status()
            for inv in (r.json().get("data") or []):
                if conv_id in str(inv.get("conversation") or "") and not inv.get("accepted"):
                    post(c, RECV_BE, "graph/invitation-accept", {"invitation_id": inv.get("id")})
                    return True
            return False
        if not until(accept):
            fail("receiver never accepted the invitation")
        print("    receiver accepted")

        print("· step 5: receiver syncs, downloads bundle, maps project, re-downloads → places")
        import json as _json

        def fm_ids() -> list[str]:
            rconv = get(c, RECV_BE, f"graph/conversation/{conv_id}")
            out = []
            for p in _json.loads((rconv or {}).get("message_ids") or "[]"):
                tid = str(p.get("typeid") or "")
                if "-@" in tid:
                    out.append(tid.split("-@", 1)[1])
            return out

        def conv_has_message():
            post(c, RECV_BE, "graph/conversation-list", {})
            post(c, RECV_BE, "graph/conversation-message-sync", {"conversation_id": conv_id})
            return len(fm_ids()) > 0
        if not until(conv_has_message):
            fail("receiver never received the message")
        fids = fm_ids()
        print(f"    received FM(s): {[f[:8] for f in fids]}")

        # 1st download: unpacks the bundle (sets remote_project_id from the conv
        # header; the git-origin skill PARKS for lack of a mapped project).
        for fid in fids:
            try:
                post(c, RECV_BE, f"graph/flow_message/{fid}/download_body", {"overwrite": True})
            except Exception as e:
                print(f"    (download#1 {fid[:8]}: {e})")

        rproj = post(c, RECV_BE, "graph/project", {"name": f"reflect-dst-{stamp}",
                                                   "fs_storage_mount_path": str(recv_proj)})
        recv_pid = rproj["id"]
        rconv = get(c, RECV_BE, f"graph/conversation/{conv_id}")
        remote_pid = (rconv or {}).get("remote_project_id") or sender_pid
        post(c, RECV_BE, "graph/set-project-mapping",
             {"remote_project_id": remote_pid, "local_project_id": recv_pid})
        print(f"    mapped remote {remote_pid} → local {recv_pid} ({recv_proj})")

        expected = recv_proj / REL_PATH / "SKILL.md"

        def placed():
            # 2nd download with a project now mapped → assets un-park and place at
            # their git-origin rel_path.
            for fid in fm_ids():
                try:
                    post(c, RECV_BE, f"graph/flow_message/{fid}/download_body", {"overwrite": True})
                except Exception as e:
                    print(f"    (download#2 {fid[:8]}: {e})")
            return expected.exists()

        ok = until(placed)
        print(f"    expected reconstructed path: {expected}")
        print(f"    exists on receiver: {expected.exists()}")
        if not ok:
            print("    --- DIAGNOSTICS ---")
            rconv = get(c, RECV_BE, f"graph/conversation/{conv_id}")
            print(f"    recv conv: project_id={rconv.get('project_id')} remote_project_id={rconv.get('remote_project_id')} "
                  f"msg_count={rconv.get('message_count')}")
            for fid in fm_ids():
                fm = get(c, RECV_BE, f"graph/flow_message/{fid}")
                atts = [(a.get('attachment_type'), str(a.get('data'))[:40]) for a in (fm.get('attachment') or [])]
                print(f"    recv FM {fid[:8]}: body_status={fm.get('body_status')} "
                      f"attachment_filename={fm.get('attachment_filename')} atts={atts}")
            # Did the skill arrive hub-hosted (not via bundle)?
            try:
                rsk = get(c, RECV_BE, f"graph/skill/{skill_id}")
                print(f"    recv skill row: exists={bool(rsk)} asset_ref={rsk.get('asset_ref') if rsk else None} "
                      f"git_origin={rsk.get('git_origin') if rsk else None}")
            except Exception as e:
                print(f"    recv skill row: {e}")
            hits = list(recv_proj.rglob("SKILL.md"))
            print(f"    SKILL.md under receiver project: {[str(p) for p in hits]}")
            home_hits = list(Path(os.path.expanduser('~/.flow/instances/gx8')).rglob('SKILL.md'))[:5]
            print(f"    SKILL.md under gx8 instance dir (sample): {[str(p) for p in home_hits]}")
            fail("git reflection did NOT reconstruct the nested repo path on the receiver")
        print("    ✅ skill reconstructed at the SAME repo-relative path")

        print("· step 6: receiver entity carries git_origin")
        rskill = get(c, RECV_BE, f"graph/skill/{skill_id}")
        go = (rskill or {}).get("git_origin")
        print(f"    git_origin = {go}")
        if not go or go.get("rel_path") != REL_PATH:
            fail(f"receiver skill missing/incorrect git_origin (got {go})")
        print("    ✅ git_origin stamped with the sender's repo-relative path")

    print("\n✅ PASS: git reflection reconstructs the same path end-to-end (real backends + hub)")
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
