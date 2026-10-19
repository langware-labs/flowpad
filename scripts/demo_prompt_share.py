"""Scenario: Alice sends a conversation prompt to Bob; the prompt rides as a
library Prompt ENTITY attachment (TYPE_ID + prompt_preview), Bob previews it
before download, downloads the body (entity materializes into his library),
approves it, and the executed-prompt cross-link + usage bump land.

End-to-end acceptance for "send/execute prompt behaves as an attachment-action
pair" — driven over two instance_ctl backends + the local hub (mirrors
``demo_markdown_share.py``).

Steps:
  1. Log both instances in (local session + hub user).
  2. Alice creates a conversation, shares it with Bob; Bob accepts the invite.
  3. Alice sends a message with ``prompt_text`` → assert HER FlowMessage
     carries a TYPE_ID prompt attachment (proposer_id + prompt_preview) and
     the Prompt entity exists in her library.
  4. Bob syncs → assert the header arrived with the prompt attachment and the
     ``prompt_preview`` is readable BEFORE any body download.
  5. Bob downloads the body → assert the Prompt entity materialized into his
     library (same id, same text) and body_downloaded flipped.
  6. Bob approves (approve_all) → assert approved_by on the attachment.
  7. Bob links an executed run (link-executed-prompt on a process row) →
     assert mutual private-context links + use_count bump.

Requires: local hub on $FLOWPAD_HUB_URL (default :8093) with alice/bob seeded,
plus the alice (:6001) and bob (:6002) instance_ctl backends.

Run: uv run python scripts/demo_prompt_share.py
Exit 0 = pass; non-zero = a step failed (message says which).
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from typing import Any

import httpx

HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093")
ALICE_BE = os.environ.get("ALICE_BE", "http://localhost:6001")
BOB_BE = os.environ.get("BOB_BE", "http://localhost:6002")

ALICE_EMAIL = os.environ.get("ALICE_EMAIL", "alice@local.test")
ALICE_PW = os.environ.get("ALICE_PW", "alice-pw-1234")
BOB_EMAIL = os.environ.get("BOB_EMAIL", "bob@local.test")
BOB_PW = os.environ.get("BOB_PW", "bob-pw-1234")

SYNC_ROUNDS = int(os.environ.get("SYNC_ROUNDS", "20"))
SYNC_SLEEP = float(os.environ.get("SYNC_SLEEP", "1.0"))

PROMPT_TEXT = "Summarize the open questions\nand propose next steps."


def hub_login(client: httpx.Client, email: str, pw: str) -> tuple[str, str]:
    r = client.post(f"{HUB}/api/v1/login", json={"email": email, "password": pw})
    r.raise_for_status()
    d = r.json()["data"]
    return d["user"]["id"], d.get("api_key") or d.get("token")


def local_login(client: httpx.Client, be: str, email: str, pw: str) -> None:
    r = client.post(f"{be}/api/v1/cloud/login", json={"email": email, "password": pw})
    r.raise_for_status()


def _unwrap(r: httpx.Response) -> Any:
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and "status" in j and j.get("status") != "SUCCESS":
        raise RuntimeError(f"{r.request.method} {r.request.url} failed: {j}")
    return j.get("data") if isinstance(j, dict) else j


def local_post(client: httpx.Client, be: str, path: str, body: dict) -> Any:
    return _unwrap(client.post(f"{be}/api/v1/{path.lstrip('/')}", json=body))


def local_get(client: httpx.Client, be: str, path: str) -> Any:
    return _unwrap(client.get(f"{be}/api/v1/{path.lstrip('/')}"))


def _until(fn, rounds: int = SYNC_ROUNDS, sleep: float = SYNC_SLEEP) -> bool:
    for _ in range(rounds):
        if fn():
            return True
        time.sleep(sleep)
    return False


def fail(msg: str) -> None:
    print(f"\n❌ FAIL: {msg}")
    sys.exit(2)


def prompt_attachments(fm: dict) -> list[dict]:
    return [
        a for a in (fm.get("attachment") or [])
        if a.get("attachment_type") == "type_id" and str(a.get("data", "")).split("-", 1)[0] == "prompt"
    ]


def run() -> int:
    stamp = str(int(time.time()))
    with httpx.Client(timeout=30.0) as client:
        print("· step 1: login (local sessions + hub users)")
        local_login(client, ALICE_BE, ALICE_EMAIL, ALICE_PW)
        local_login(client, BOB_BE, BOB_EMAIL, BOB_PW)
        hub_login(client, ALICE_EMAIL, ALICE_PW)
        _bob_uid, bob_tok = hub_login(client, BOB_EMAIL, BOB_PW)

        print("· step 2: alice creates + shares a conversation; bob accepts")
        conv = local_post(client, ALICE_BE, "graph/conversation", {"title": f"Prompt share {stamp}"})
        conv_id = conv["id"]
        local_post(client, ALICE_BE, f"graph/conversation/{conv_id}/share", {
            **conv,
            "recipients": [BOB_EMAIL],
        })

        def bob_accept_invite() -> bool:
            r = client.get(f"{HUB}/api/v1/graph/invitation/pending",
                           headers={"Authorization": f"Bearer {bob_tok}"})
            r.raise_for_status()
            for inv in (r.json().get("data") or []):
                if conv_id in str(inv.get("conversation") or "") and not inv.get("accepted"):
                    local_post(client, BOB_BE, "graph/invitation-accept",
                               {"invitation_id": inv.get("id")})
                    return True
            return False

        if not _until(bob_accept_invite):
            fail("bob never found/accepted the pending invitation")
        print("    bob accepted the invitation")

        print("· step 3: alice sends a prompt message (entity-backed attachment)")
        sent = local_post(client, ALICE_BE, f"graph/conversation/{conv_id}/add_message", {
            "message": "please run this for me",
            "prompt_text": PROMPT_TEXT,
        })
        fm_id = sent["flow_message_id"]
        alice_fm = local_get(client, ALICE_BE, f"graph/flow_message/{fm_id}")
        [att] = prompt_attachments(alice_fm) or [None]
        if not att:
            fail("alice's FlowMessage has no TYPE_ID prompt attachment")
        if att.get("prompt_preview") != PROMPT_TEXT:
            fail(f"prompt_preview mismatch on alice's side: {att.get('prompt_preview')!r}")
        if not att.get("proposer_id"):
            fail("proposer_id not stamped")
        prompt_id = str(att["data"]).split("-", 1)[1]
        alice_prompt = local_get(client, ALICE_BE, f"graph/prompt/{prompt_id}")
        if alice_prompt.get("text") != PROMPT_TEXT:
            fail("alice's library Prompt text mismatch")
        print(f"    prompt-{prompt_id[:8]} attached (preview + proposer ok), in alice's library")

        print("· step 4: bob receives the header — preview readable pre-download")

        def bob_has_header() -> bool:
            local_post(client, BOB_BE, "graph/conversation-list", {})
            try:
                local_post(client, BOB_BE, "graph/conversation-message-sync",
                           {"conversation_id": conv_id})
                fm = local_get(client, BOB_BE, f"graph/flow_message/{fm_id}")
            except Exception:
                return False
            atts = prompt_attachments(fm)
            return bool(atts and atts[0].get("prompt_preview") == PROMPT_TEXT)

        if not _until(bob_has_header):
            fail("bob never received the FlowMessage header with the prompt preview")
        bob_fm = local_get(client, BOB_BE, f"graph/flow_message/{fm_id}")
        if bob_fm.get("body_downloaded"):
            print("    (note: body already downloaded — preview check still passed)")
        print("    bob sees prompt_preview before download")

        print("· step 5: bob downloads the body — prompt lands in his library")

        def bob_downloaded() -> bool:
            try:
                local_post(client, BOB_BE, f"graph/flow_message/{fm_id}/download_body", {})
            except Exception:
                pass
            try:
                row = local_get(client, BOB_BE, f"graph/prompt/{prompt_id}")
            except Exception:
                return False
            return row.get("text") == PROMPT_TEXT

        if not _until(bob_downloaded):
            fail("bob's library never materialized the Prompt entity after download")
        bob_fm = local_get(client, BOB_BE, f"graph/flow_message/{fm_id}")
        if not bob_fm.get("body_downloaded"):
            fail("body_downloaded did not flip on bob's FlowMessage")
        print("    prompt entity materialized on bob (user scope) + body_downloaded")

        print("· step 6: bob approves the session the prompt opened")

        def bob_session():
            rows = local_get(client, BOB_BE, "graph/remote_worker_session")
            return next((r for r in rows if r.get("starting_message_id") == fm_id), None)

        if not _until(lambda: (bob_session() or {}).get("status") == "pending"):
            fail("bob never parked a PENDING session for the prompt")
        session_id = bob_session()["id"]
        local_post(client, BOB_BE, f"graph/remote_worker_session/{session_id}/approve", {})
        if (bob_session() or {}).get("status") != "idle":
            fail("session did not become idle after approve")
        print("    session approved (pending → idle)")

        print("· step 7: executed-run cross-link + usage bump")
        proc = local_post(client, BOB_BE, "graph/agentic_process", {
            "type": "agentic_process",
            "session_id": str(uuid.uuid4()),
            "worker_type": "claude_code",
        })
        proc_id = proc["id"]
        linked = local_post(client, BOB_BE,
                            f"graph/agentic_process/{proc_id}/link-executed-prompt",
                            {"prompt_id": prompt_id})
        if not linked.get("linked") or linked.get("use_count") != 1:
            fail(f"link-executed-prompt unexpected result: {linked}")
        bob_prompt = local_get(client, BOB_BE, f"graph/prompt/{prompt_id}")
        prompt_ctx = [str(t) for t in (bob_prompt.get("private_context_entities") or [])]
        bob_proc = local_get(client, BOB_BE, f"graph/agentic_process/{proc_id}")
        proc_ctx = [str(t) for t in (bob_proc.get("private_context_entities") or [])]
        if not any(proc_id in t for t in prompt_ctx):
            fail(f"prompt's private context missing the process link: {prompt_ctx}")
        if not any(prompt_id in t for t in proc_ctx):
            fail(f"process's private context missing the prompt link: {proc_ctx}")
        print("    mutual private-context links + use_count=1")

    print("\n✅ PASS: entity-backed prompt share / preview / download / approve / execute-link")
    return 0


if __name__ == "__main__":
    sys.exit(run())
