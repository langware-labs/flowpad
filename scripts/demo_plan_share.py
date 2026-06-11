"""Scenario: dev-1 shares a PLAN (Spec, spec_type=plan) to dev-2; dev-2 accepts,
syncs, downloads the bundle, and the spec BODY materializes (renders, not blank).

End-to-end acceptance for the .flowmsg unpack unification fix — the receiver's
generic restore→reindex must heal/materialize the shared spec's content. Driven
over two instance_ctl backends + the local hub.

Run: FLOWPAD_HUB_URL=http://localhost:8093 uv run python scripts/demo_plan_share.py
Exit 0 = pass; 2 = a step failed.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any

import httpx

HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093")
A_BE = os.environ.get("ALICE_BE", "http://localhost:6001")   # dev-1 sender
B_BE = os.environ.get("BOB_BE", "http://localhost:6002")     # dev-2 receiver
A_EMAIL = os.environ.get("ALICE_EMAIL", "dev-1@local.test")
A_PW = os.environ.get("ALICE_PW", "dev-1-pw-1234")
B_EMAIL = os.environ.get("BOB_EMAIL", "dev-2@local.test")
B_PW = os.environ.get("BOB_PW", "dev-2-pw-1234")

ROUNDS = int(os.environ.get("SYNC_ROUNDS", "25"))
SLEEP = float(os.environ.get("SYNC_SLEEP", "1.0"))


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


def hub_login(c, email, pw):
    r = c.post(f"{HUB}/api/v1/login", json={"email": email, "password": pw})
    r.raise_for_status()
    d = r.json()["data"]
    return d["user"]["id"], d.get("api_key") or d.get("token")


def until(fn):
    for _ in range(ROUNDS):
        if fn():
            return True
        time.sleep(SLEEP)
    return False


def fail(m):
    print(f"\n❌ FAIL: {m}")
    sys.exit(2)


def run():
    stamp = str(int(time.time()))
    sentinel = f"SENTINEL-PLAN-{stamp}"
    with httpx.Client(timeout=40.0) as c:
        print("· step 1: login both instances (local + hub)")
        post(c, A_BE, "cloud/login", {"email": A_EMAIL, "password": A_PW})
        post(c, B_BE, "cloud/login", {"email": B_EMAIL, "password": B_PW})
        hub_login(c, A_EMAIL, A_PW)
        _b_uid, b_tok = hub_login(c, B_EMAIL, B_PW)

        print("· step 2: dev-1 creates a PLAN (Spec, spec_type=plan) with a body")
        # A plan is just a Spec entity — created the generic way, then shared as
        # a plain TYPE_ID attachment in step 5 (no Task minted on share).
        created = post(c, A_BE, "graph/spec", {
            "title": f"Plan: Hello World {stamp}",
            "content": f"# Plan\n\n## Step 1\n\n{sentinel}\n\n## Step 2\n\nDone.\n",
            "spec_type": "plan",
        })
        spec_id = created["id"]
        # sender's spec must carry the body. ``content`` is a blob (not in the
        # GET) — verify via the real asset_ref file the editor renders.
        a_spec = get(c, A_BE, f"graph/spec/{spec_id}")
        a_ref = a_spec.get("asset_ref")
        if not a_ref or not os.path.isfile(a_ref) or sentinel not in open(a_ref, encoding="utf-8").read():
            fail(f"sender spec.md missing body: asset_ref={a_ref!r}")
        print(f"    spec={spec_id[:8]} sender spec.md OK ({a_ref})")

        print("· step 3: dev-1 creates + shares a conversation; dev-2 accepts")
        conv = post(c, A_BE, "graph/conversation", {"title": f"Plan share {stamp}"})
        conv_id = conv["id"]
        post(c, A_BE, f"graph/conversation/{conv_id}/share", {**conv, "recipients": [B_EMAIL]})

        print("· step 4: dev-2 accepts the invitation")

        def accept():
            r = c.get(f"{HUB}/api/v1/graph/invitation/pending",
                      headers={"Authorization": f"Bearer {b_tok}"})
            r.raise_for_status()
            for inv in (r.json().get("data") or []):
                if conv_id in str(inv.get("conversation") or "") and not inv.get("accepted"):
                    post(c, B_BE, "graph/invitation-accept", {"invitation_id": inv.get("id")})
                    return True
            return False

        if not until(accept):
            fail("dev-2 never accepted the invitation")
        print("    dev-2 accepted")

        print("· step 5: dev-1 sends the plan into the conversation (uploads body)")
        sent = post(c, A_BE, f"graph/conversation/{conv_id}/add_message", {
            "message": "Please review this plan",
            "asset_references": [f"spec-{spec_id}"],
        })
        fm_id = sent.get("flow_message_id") if isinstance(sent, dict) else None
        print(f"    sent fm={str(fm_id)[:8]}")

        print("· step 6: dev-2 syncs + downloads bundle → spec BODY must materialize")

        def bob_has_plan_body():
            post(c, B_BE, "graph/conversation-list", {})
            try:
                post(c, B_BE, "graph/conversation-message-sync", {"conversation_id": conv_id})
            except Exception:
                pass
            try:
                post(c, B_BE, f"graph/flow_message/{fm_id}/download_body", {})
            except Exception:
                pass
            try:
                post(c, B_BE, "graph/conversation-message-sync", {"conversation_id": conv_id})
            except Exception:
                pass
            try:
                row = get(c, B_BE, f"graph/spec/{spec_id}")
            except Exception:
                return False
            if not row:
                return False
            ref = row.get("asset_ref")
            # Receiver materialized the row AND its body file (the editor's
            # render source) carries the real plan body — not a blank stub.
            return bool(ref and os.path.isfile(ref) and sentinel in open(ref, encoding="utf-8").read())

        if not until(bob_has_plan_body):
            try:
                row = get(c, B_BE, f"graph/spec/{spec_id}")
                ref = row.get("asset_ref") if row else None
                got = (open(ref, encoding="utf-8").read()[:120] if ref and os.path.isfile(ref)
                       else f"<no body file; row={bool(row)}, asset_ref={ref!r}>")
            except Exception as e:
                got = f"<error {e}>"
            fail(f"dev-2's spec body never materialized (blank plan). got={got!r}")

        b_spec = get(c, B_BE, f"graph/spec/{spec_id}")
        b_ref = b_spec.get("asset_ref")
        print(f"    ✅ dev-2 spec materialized: spec_type={b_spec.get('spec_type')}, "
              f"asset_ref={b_ref}, sentinel present in body file")
        print("\n✅ PASS: plan shared dev-1 → dev-2 → downloaded → unpacked → "
              "indexed → body materialized (renders, not blank).")
        print(f"   Verify in browser: {B_BE.replace('6002','5012')}/dock/conversation/{conv_id}")
        return 0


if __name__ == "__main__":
    sys.exit(run())
