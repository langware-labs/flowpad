"""Canonical demo: Alice ↔ Bob production-incident conversation through the local hub.

Creates a fresh hub project + conversation, seeds 8 messages that walk through
a real-feeling incident together, attaches typed-entity chips + text. The
conversation is reachable from both instances' inboxes:

  Alice: http://localhost:4098/dock/inbox  → click the new row
  Bob:   http://localhost:4099/dock/inbox  → click the new row

Requires:
  - Local hub on $FLOWPAD_HUB_URL (default http://localhost:8093) — see
    test_flowpad/FlowPad
  - alice@local.test + bob@local.test seeded on the hub
    (test_flowpad/FlowPad/ops/scripts/setup_test_users.sh)
  - flowpad-oss BE on $OSS_BE_PORT (default 9008) — alice
  - flowpad-app BE on $APP_BE_PORT (default 9009) — bob
  - Both BEs logged in (POST /cloud/login fires env-mode auto-login from
    each repo's .env.local)

After seeding, runs conversation-list on bob to dispatch the catch-up fetch
and prints both BEs' message counts so the demo URL is ready to click.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any

import httpx


HUB = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093")
OSS_BE = os.environ.get("OSS_BE", "http://localhost:9008")
APP_BE = os.environ.get("APP_BE", "http://localhost:9009")
OSS_FE = os.environ.get("OSS_FE", "http://localhost:4098")
APP_FE = os.environ.get("APP_FE", "http://localhost:4099")

ALICE_EMAIL = os.environ.get("ALICE_EMAIL", "alice@local.test")
ALICE_PW = os.environ.get("ALICE_PW", "alice-pw-1234")
BOB_EMAIL = os.environ.get("BOB_EMAIL", "bob@local.test")
BOB_PW = os.environ.get("BOB_PW", "bob-pw-1234")


def hub_login(client: httpx.Client, email: str, pw: str) -> tuple[str, str]:
    """Return (user_id, jwt_token)."""
    r = client.post(f"{HUB}/api/v1/login", json={"email": email, "password": pw})
    r.raise_for_status()
    d = r.json()["data"]
    return d["user"]["id"], d.get("api_key") or d.get("token")


def local_login(client: httpx.Client, be: str, email: str, pw: str) -> None:
    r = client.post(f"{be}/api/v1/cloud/login",
                    json={"email": email, "password": pw})
    r.raise_for_status()


def hub_post(client: httpx.Client, path: str, body: dict, token: str) -> dict:
    r = client.post(f"{HUB}/api/v1/{path.lstrip('/')}", json=body,
                    headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    j = r.json()
    if j.get("status") != "SUCCESS":
        raise RuntimeError(f"hub POST {path} failed: {j}")
    return j["data"]


def hub_get(client: httpx.Client, path: str, token: str) -> Any:
    r = client.get(f"{HUB}/api/v1/{path.lstrip('/')}",
                   headers={"Authorization": f"Bearer {token}"})
    r.raise_for_status()
    return r.json().get("data")


# The 8 messages — alternating alice/bob, walking through a real-feeling
# incident: detect → diagnose → quantify → mitigate → fix → verify → wrap.
# attachment_typeids reference entities that may or may not exist on each
# side; the chip falls back gracefully when not resolved.
SCRIPT: list[dict] = [
    {
        "role": "alice",
        "text": (
            "Hey Bob — checkout-api p99 latency just jumped 80ms → 4.2s at 14:03 UTC. "
            "Error rate is normal, just slow. v2.41 hit canary at 13:45. "
            "Attaching the incident spec; pulling Datadog now."
        ),
        "attachment_typeids": ["spec-aa111111-1111-4111-8111-111111111101"],
    },
    {
        "role": "bob",
        "text": (
            "Got it. Spinning up my on-call responder agent — sharing it so you "
            "have it for next time too. Pull 2-3 trace IDs with p99 > 3s in the "
            "last 10 min and drop them here."
        ),
        "attachment_typeids": ["agent-aa111111-1111-4111-8111-111111111102"],
    },
    {
        "role": "alice",
        "text": (
            "Three traces, all on /checkout/finalize:\n"
            "  • tr_a1b2c3 — 4.2s, 8-item cart\n"
            "  • tr_c3d4e5 — 3.8s, 6-item cart\n"
            "  • tr_e5f6a7 — 4.6s, 11-item cart\n"
            "Latency scales with cart size — pattern-y."
        ),
    },
    {
        "role": "bob",
        "text": (
            "Classic N+1 shape. Before we trace queries, let me quantify the user "
            "impact so we know whether to keep digging or roll back now. Sharing my "
            "blast-radius skill — Approve & Run it."
        ),
        "attachment_typeids": ["skill-aa111111-1111-4111-8111-111111111103"],
    },
    {
        "role": "alice",
        "text": (
            "Ran it:\n"
            "  • Lost req-seconds: ~80 sec/req at p99 × 6.4k req/s canary = ~512 user-seconds/min\n"
            "  • Affected users (10% canary): ~640 active sessions / min\n"
            "  • Recommendation: ROLL BACK CANARY NOW, diagnose offline\n"
            "Looping canary back to v2.40."
        ),
    },
    {
        "role": "bob",
        "text": (
            "Good call. Now that the bleeding's stopped — let's actually find the "
            "regression. Sharing my trace-n-plus-one skill. Run it against those "
            "three trace IDs."
        ),
        "attachment_typeids": ["skill-aa111111-1111-4111-8111-111111111104"],
    },
    {
        "role": "alice",
        "text": (
            "Found it. cart_service.py:142 — enrich_cart_lines() switched from a single "
            "batched product_repo.get_many() to a per-line .get() in v2.41. Each line = "
            "one ~500ms call. 8 lines = 4s. Fix plan attached, going to ship + add a "
            "regression test."
        ),
        "attachment_typeids": [
            "spec-aa111111-1111-4111-8111-111111111105",
            "skill-aa111111-1111-4111-8111-111111111106",
        ],
    },
    {
        "role": "bob",
        "text": (
            "Reviewed — ship it. Nice catch keeping v2.41 on canary instead of rolling "
            "100% this morning. That's the only reason this stayed SEV-2. Link this "
            "conversation in the postmortem doc."
        ),
    },
]


def main() -> int:
    print(f"[setup] hub={HUB}  oss_be={OSS_BE}  app_be={APP_BE}")
    with httpx.Client(timeout=20.0) as client:
        # Local auto-login both sides (idempotent, warms credentials)
        local_login(client, OSS_BE, ALICE_EMAIL, ALICE_PW)
        local_login(client, APP_BE, BOB_EMAIL, BOB_PW)

        alice_id, alice_tok = hub_login(client, ALICE_EMAIL, ALICE_PW)
        bob_id, bob_tok = hub_login(client, BOB_EMAIL, BOB_PW)
        print(f"[setup] alice={alice_id}  bob={bob_id}")

        # Fresh hub project for this demo so old stress-test convs don't clutter
        proj = hub_post(client, "/graph/project",
                        {"name": f"alice-bob-demo-{int(time.time())}"}, alice_tok)
        proj_id = proj["id"]
        print(f"[setup] hub project: {proj_id}")

        # Alice starts the conversation with message #0
        first = SCRIPT[0]
        body = {
            "text": first["text"],
            "receiver_address": bob_id,
            "receiver_address_type": "id",
        }
        if first.get("attachment_typeids"):
            body["attachment"] = [
                {"attachment_type": "type_id", "data": t}
                for t in first["attachment_typeids"]
            ]
        conv = hub_post(client, f"/graph/project/{proj_id}/start_guest_conversation",
                        body, alice_tok)
        conv_id = conv["id"]
        print(f"[setup] conversation: {conv_id}")
        print()

        # Subsequent messages via /add_message, each as the role's user
        for i, m in enumerate(SCRIPT[1:], start=1):
            tok = alice_tok if m["role"] == "alice" else bob_tok
            body = {"text": m["text"]}
            if m.get("attachment_typeids"):
                body["attachment"] = [
                    {"attachment_type": "type_id", "data": t}
                    for t in m["attachment_typeids"]
                ]
            r = hub_post(client, f"/graph/conversation/{conv_id}/add_message",
                         body, tok)
            kind = "💬"
            if m.get("attachment_typeids"):
                kind = "📎"
            print(f"  [{i:2d}] {m['role']:6s} {kind} {m['text'][:60]!r}")
            time.sleep(0.05)  # let hub serialize cleanly

        print()
        print("[verify] hub message count")
        msgs = hub_get(client, f"/graph/conversation/{conv_id}/flow_message", alice_tok)
        print(f"  hub: {len(msgs or [])} messages")

        # Trigger per-side fetch so both UIs are ready
        print()
        print("[sync] dispatching conversation-list on both BEs…")
        for label, be in (("alice/oss", OSS_BE), ("bob/app", APP_BE)):
            r = client.post(f"{be}/api/v1/graph/conversation-list", json={})
            d = (r.json() or {}).get("data") or {}
            print(f"  {label}: bg_fetch_dispatched={d.get('bg_fetch_dispatched')}")

        # Give the BG fetch a moment, then sample the local count
        time.sleep(8)
        for label, be in (("alice/oss", OSS_BE), ("bob/app", APP_BE)):
            r = client.get(f"{be}/api/v1/graph/conversation/{conv_id}/flow_message")
            n = len((r.json() or {}).get("data") or [])
            print(f"  {label}: local fm count = {n}")

        print()
        print("=" * 78)
        print(f"DEMO READY  ({len(SCRIPT)} messages)")
        print()
        print(f"  Alice (oss): {OSS_FE}/dock/conversation/{conv_id}")
        print(f"  Bob   (app): {APP_FE}/dock/conversation/{conv_id}")
        print()
        print("Each side will catch up on first conversation-list refresh.")
        print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
