"""Scenario: Alice shares a markdown to Bob, Bob comments, Alice receives it.

End-to-end acceptance test for recursive share + live child (comment) sync,
driven over the local backends + the local hub (mirrors
``demo_alice_bob_full_hub.py``).

Flow (5 steps):
  1. Log both instances in (local session + hub user).
  2. Alice creates a markdown, wraps it as a conversation's shared context, and
     shares the conversation with Bob. The share makes the markdown a hub
     ``is_child`` of the conversation (remote), so member roles propagate.
  3. Bob's side syncs: the markdown is deployed into Bob's docs + indexed
     (already-existing behavior). Assert Bob's backend has the markdown.
  4. Bob adds a comment on the markdown (POST /graph/markdown/<id>/comment).
     Because the markdown is remote on Bob's side, the comment auto-creates as
     a hub child and the hub emits ``child_created`` to the markdown's watchers.
  5. Assert Alice's backend RECEIVED the comment: a hub-origin (remote=True)
     comment child of the markdown, materialized by the hub bridge.

"Real time" is a FE concern (the gutter re-renders on the local op the bridge
emits). This headless script verifies the data-level arrival — the backend
holds the comment — which is exactly what the FE renders.

Requires (same as demo_alice_bob_full_hub.py):
  - Local hub on $FLOWPAD_HUB_URL (default http://localhost:8093)
  - alice@local.test + bob@local.test seeded on the hub
  - flowpad-oss BE on $OSS_BE (9008, alice) + flowpad-app BE on $APP_BE (9009, bob)

Run: uv run python scripts/demo_markdown_share.py
Exit 0 = pass; non-zero = a step failed (message says which).
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any

import httpx

HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093")
OSS_BE = os.environ.get("OSS_BE", "http://localhost:9008")   # alice
APP_BE = os.environ.get("APP_BE", "http://localhost:9009")   # bob

ALICE_EMAIL = os.environ.get("ALICE_EMAIL", "alice@local.test")
ALICE_PW = os.environ.get("ALICE_PW", "alice-pw-1234")
BOB_EMAIL = os.environ.get("BOB_EMAIL", "bob@local.test")
BOB_PW = os.environ.get("BOB_PW", "bob-pw-1234")

SYNC_ROUNDS = int(os.environ.get("SYNC_ROUNDS", "20"))
SYNC_SLEEP = float(os.environ.get("SYNC_SLEEP", "1.0"))


# --- helpers (mirror demo_alice_bob_full_hub.py) ---------------------------
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


def fail(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"\n❌ FAIL: {msg}")
    sys.exit(2)


def run() -> int:
    stamp = str(int(time.time()))
    with httpx.Client(timeout=30.0) as client:
        # --- Step 1: log in -------------------------------------------------
        print("· step 1: login (local sessions + hub users)")
        local_login(client, OSS_BE, ALICE_EMAIL, ALICE_PW)
        local_login(client, APP_BE, BOB_EMAIL, BOB_PW)
        hub_login(client, ALICE_EMAIL, ALICE_PW)
        _bob_uid, bob_tok = hub_login(client, BOB_EMAIL, BOB_PW)

        # --- Step 2: Alice creates + shares a markdown ----------------------
        print("· step 2: alice creates markdown + shares conversation")
        # Markdown is file-backed with a path-derived id. Write a unique .md to
        # a shared (same-machine) docs dir and create the row pointing at it, so
        # Bob's chip-open self-heal (step 3) can index the SAME file → same id.
        docs_dir = os.path.expanduser("~/docs")
        os.makedirs(docs_dir, exist_ok=True)
        md_path = os.path.join(docs_dir, f"sharetest-{stamp}.md")
        body = "# Shared doc\n\nLine 2\nLine 3 (Bob will comment here)\n"
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(body)
        md = local_post(client, OSS_BE, "graph/markdown", {
            "title": f"Shared doc {stamp}",
            "asset_ref": md_path,
        })
        md_id = md["id"]
        md_ref = f"markdown-{md_id}"
        # Write the assigned id into the file's frontmatter so the RECIPIENT
        # adopts it (validate-on-adopt) when it discovers the same file — keeping
        # alice's and bob's markdown ids identical (the shared file carries its id).
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(f"---\nid: {md_id}\n---\n\n{body}")
        print(f"    markdown {md_ref}  ({md_path})")

        conv = local_post(client, OSS_BE, "graph/conversation", {
            "title": f"Doc share {stamp}",
            "shared_context_entities": [md_ref],
        })
        conv_id = conv["id"]
        print(f"    conversation conversation-{conv_id}")

        # Share = hub create + invite bob + (new) attach markdown as is_child.
        local_post(client, OSS_BE, f"graph/conversation/{conv_id}/share", {
            **conv,
            "recipients": [BOB_EMAIL],
        })

        # --- Step 3: Bob accepts the invitation, then receives the markdown --
        print("· step 3: bob accepts invitation (member role + join) + syncs")

        # Bob must accept the pending invitation before he has any role on the
        # conversation — without it every conversation-scoped hub call (and the
        # comment auto-share in step 4) 401s. Mirrors the UI's accept click.
        def bob_accept_invite() -> bool:
            r = client.get(f"{HUB}/api/v1/graph/invitation/pending",
                           headers={"Authorization": f"Bearer {bob_tok}"})
            r.raise_for_status()
            for inv in (r.json().get("data") or []):
                if conv_id in str(inv.get("conversation") or "") and not inv.get("accepted"):
                    local_post(client, APP_BE, "graph/invitation-accept",
                               {"invitation_id": inv.get("id")})
                    return True
            return False

        if not _until(bob_accept_invite):
            fail("bob never found/accepted the pending invitation for the conversation")
        print("    bob accepted the invitation (member role + joined)")

        def bob_has_markdown() -> bool:
            # (a) sync the conversation (brings the conv + shared_context refs)
            local_post(client, APP_BE, "graph/conversation-list", {})
            local_post(client, APP_BE, "graph/conversation-message-sync",
                       {"conversation_id": conv_id})
            # (b) reproduce the chip-open via the REAL resolver: discover scans
            #     the file on disk (same machine), adopts its frontmatter id
            #     (== md_id, validate-on-adopt), and syncs it to Bob's DB.
            try:
                local_post(
                    client, APP_BE,
                    f"graph/compute_node/@local/fs-records/markdown/discover?path={md_path}",
                    {},
                )
            except Exception:
                pass
            # (c) re-sync so the subtree catch-up links parent_type_id=conversation
            local_post(client, APP_BE, "graph/conversation-message-sync",
                       {"conversation_id": conv_id})
            try:
                row = local_get(client, APP_BE, f"graph/markdown/{md_id}")
            except Exception:
                return False
            return bool(row and (row.get("id") == md_id))

        if not _until(bob_has_markdown):
            fail(f"bob's backend never materialized {md_ref} after {SYNC_ROUNDS} rounds")
        print("    bob has the markdown row")

        # --- Step 4: Bob comments on the markdown ---------------------------
        print("· step 4: bob adds a comment (child of the markdown)")
        comment = local_post(client, APP_BE, f"graph/markdown/{md_id}/comment", {
            "raw_content": f"Bob's comment {stamp}",
            "data": {"line": 3},
        })
        comment_id = comment["id"]
        print(f"    comment comment-{comment_id}")

        # --- Step 5: Alice receives the comment -----------------------------
        print("· step 5: assert alice receives the comment (remote child)")
        def alice_has_comment() -> bool:
            local_post(client, OSS_BE, "graph/conversation-message-sync",
                       {"conversation_id": conv_id})
            try:
                rows = local_get(client, OSS_BE, f"graph/markdown/{md_id}/comment")
            except Exception:
                return False
            for c in rows or []:
                if c.get("id") == comment_id:
                    if not c.get("remote"):
                        print("    (found comment but remote flag not set yet)")
                        return False
                    # Gutter-binding: the comment MUST carry the doc as its
                    # parent (not the conversation it was hub-routed under), or
                    # it won't render on the markdown's line gutter.
                    if c.get("parent_type_id") != md_ref:
                        print(f"    (parent_type_id={c.get('parent_type_id')}, want {md_ref})")
                        return False
                    if (c.get("data") or {}).get("line") != 3:
                        print(f"    (line anchor={(c.get('data') or {}).get('line')}, want 3)")
                        return False
                    return True
            return False

        if not _until(alice_has_comment):
            fail(f"alice never received comment-{comment_id} after {SYNC_ROUNDS} rounds")
        print("    alice has the comment (remote child of the markdown)")

    print("\n✅ PASS: markdown share + comment sync end-to-end")
    return 0


def _until(predicate) -> bool:
    """Poll ``predicate`` up to SYNC_ROUNDS, sleeping SYNC_SLEEP between tries.

    Mirrors the convergence loop in demo_group_conversation.py — drives the
    catch-up sync repeatedly until the backend state converges."""
    for i in range(SYNC_ROUNDS):
        try:
            if predicate():
                return True
        except Exception as e:  # noqa: BLE001
            print(f"    (round {i}: {e})")
        time.sleep(SYNC_SLEEP)
    return False


def main() -> int:
    try:
        return run()
    except httpx.HTTPError as e:
        fail(f"HTTP error: {e}")
    except Exception as e:  # noqa: BLE001
        fail(f"{type(e).__name__}: {e}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
