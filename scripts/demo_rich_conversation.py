#!/usr/bin/env python3
"""Seed a visually rich Alice ↔ Bob conversation.

Every attachment kind the UI knows how to render shows up here — Spec, Skill,
Task, AgenticProcess, URL, REPO, FILE, inline PROMPT, PROMPT-with-file — plus
the new body_status state machine (one message demonstrates UPLOADING → READY
via fm.upload_body()).

Two context axes are demonstrated:
  * **Shared context**  — set on the Conversation itself. One project-style
    Spec is pinned conversation-wide so the toolbar / Shared Context panel
    shows it for every bubble.
  * **Private context** — per-message ``context_entities``. Each message
    pins the entities that *only it* talks about (a task it spawned, a
    previous message it's replying to, an AgenticProcess that produced its
    output). The bubble surfaces those as its own chip row.

The story flows with the artifacts — text references what's attached so the
conversation reads naturally rather than feeling like a chip catalogue.

Usage:
    # Local backend (9008) + hub (8093) must be running. Alice's backend
    # must be cloud-logged-in (POST /api/v1/cloud/login or env-mode).
    uv run python scripts/demo_rich_conversation.py

Prints the conversation URL at the end. Open it in alice's UI (4098).
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import time
from typing import Any, Optional

import httpx


LOCAL_URL = os.environ.get("LOCAL_BACKEND_URL", "http://localhost:9008").rstrip("/")
LOCAL_API = f"{LOCAL_URL}/api/v1"
HUB_URL = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093").rstrip("/")
HUB_API = f"{HUB_URL}/api/v1"
ALICE_EMAIL = os.environ.get("DEMO_ALICE_EMAIL", "alice@local.test")
BOB_EMAIL = os.environ.get("DEMO_BOB_EMAIL", "bob@local.test")
DEMO_REPO_URL = "https://github.com/example/read-receipts"


# ---------------------------------------------------------------------------
# Local backend graph helpers
# ---------------------------------------------------------------------------


async def _post_json(h: httpx.AsyncClient, path: str, body: dict) -> dict:
    r = await h.post(f"{LOCAL_API}{path}", json=body)
    r.raise_for_status()
    return (r.json() or {}).get("data") or {}


async def _create_spec(h, *, title, content, spec_type="issue") -> str:
    data = await _post_json(h, "/graph/spec", {"title": title, "content": content, "spec_type": spec_type})
    return data["id"]


async def _create_skill(h, *, name, description) -> str:
    data = await _post_json(h, "/graph/skill", {"name": name, "description": description})
    return data["id"]


async def _create_task(h, *, title, project_id: Optional[str] = None) -> str:
    payload: dict[str, Any] = {"title": title}
    if project_id:
        payload["project_id"] = project_id
    data = await _post_json(h, "/graph/task", payload)
    return data["id"]


async def _create_agentic_process(h, *, title, context_entities: Optional[list[str]] = None) -> str:
    payload: dict[str, Any] = {"title": title}
    if context_entities:
        payload["context_entities"] = context_entities
    data = await _post_json(h, "/graph/agentic_process", payload)
    return data["id"]


async def _create_conversation(h, *, title, context_entities: Optional[list[str]] = None) -> str:
    payload: dict[str, Any] = {"title": title}
    if context_entities:
        payload["context_entities"] = context_entities
    data = await _post_json(h, "/graph/conversation", payload)
    return data["id"]


async def _share_conv(h, conv_id, recipients) -> None:
    r = await h.post(
        f"{LOCAL_API}/graph/conversation/{conv_id}/share",
        json={"id": conv_id, "recipients": recipients},
    )
    r.raise_for_status()


async def _add_message(
    h,
    conv_id,
    *,
    text,
    sender_name=None,
    attachment=None,
    context_entities=None,
) -> dict:
    body: dict[str, Any] = {"text": text}
    if sender_name:
        body["sender_name"] = sender_name
    if attachment:
        body["attachment"] = attachment
    if context_entities:
        body["context_entities"] = context_entities
    r = await h.post(f"{LOCAL_API}/graph/conversation/{conv_id}/add_message", json=body)
    r.raise_for_status()
    return (r.json() or {}).get("data") or {}


# ---------------------------------------------------------------------------
# FILE / PROMPT-with-file staging — bytes into the FM's embedded VFS so the
# pack picks them up at upload_body() time.
# ---------------------------------------------------------------------------


async def _stage_file(fm_id: str, vfs_subpath: str, content: bytes) -> None:
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.storage import get_entity_embedded_storage

    storage = get_entity_embedded_storage(TypeId(type="flow_message", id=fm_id))
    await storage.upload(io.BytesIO(content), vfs_subpath)


async def _upload_body(fm_id: str) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as h:
        r = await h.post(f"{LOCAL_API}/graph/flow_message/{fm_id}/upload_body", json={})
        r.raise_for_status()
        return (r.json() or {}).get("data") or {}


# ---------------------------------------------------------------------------
# Demo prose
# ---------------------------------------------------------------------------


BRIEF_SPEC = """# Brief: Real-time read receipts

**Goal:** WhatsApp-style receipts (sent · delivered · read) on every message.
**Owner:** Alice (PM) · Bob (eng)

## Why
Users keep DM'ing each other in Slack to confirm "did you see my Flowpad
message?". That breaks the async-trust loop the conv view is supposed to
own.

## Surface
- Hub stamps `delivery_status: 'created' | 'delivered' | 'received'`
- Sender bubble renders the receipt glyph next to the timestamp.
- Per-conversation privacy: `message_status_visible=false` mutes the
  fanout to the sender for sensitive threads.
"""

ARCHITECTURE_SPEC = """# Architecture: read-receipt fanout

## Hub side
- `FlowMessage.delivery_status` field, monotonic guard in `_bump_delivery_status`.
- `Conversation._fanout_status_update()` mirrors `_fanout_message` but gates on
  `message_status_visible`.

## Bridge
- Receiver auto-fires `mark_delivered` on WS create. UI flips to "received"
  on IntersectionObserver ≥ 50% for 500ms — no battery drain.

## UI
- `MessageBubble` renders `<DeliveryReceipt status={...} />` — three glyphs.
- Sender-only; receiver sees nothing.
"""

REVIEW_CHECKLIST = """# Code review checklist — read-receipts PR

- [ ] Hub: monotonic guard on `delivery_status` update path
- [ ] Hub: privacy gate on `_fanout_status_update`
- [ ] Bridge: `mark_delivered` is fire-and-forget (no await blocking inbound)
- [ ] UI: DeliveryReceipt does not re-render on every state tick
- [ ] Tests: 4-state matrix (alice→bob, bob→alice, private mode, group)
- [ ] Telemetry: receipt-roundtrip histogram added
"""

TEST_PLAN = """# Test plan

1. `test_two_client_loop.py` — extend to assert monotonicity AND privacy gate.
2. Vitest mirror in `ui/tests/hub/` — same 4 cells.
3. Manual: long-press a bubble on iOS/Android, confirm tap targets.
"""

ROLLOUT_PLAN = """# Rollout

1. Canary at 10% behind `flag.read_receipts.enabled` for 24h.
2. Watch p99 of `_bump_delivery_status` — must stay < 80ms.
3. 100% if no SEV-3+ alerts. Announcement post + GIF for #product-launch.
"""

ANALYZER_OUTPUT = """# n+1-query-analyzer · run output

Found **3 hot trace clusters** in the past 6h.

trace_ids: 0fa·..81e2  ·  bd9·..3c01  ·  41c·..f8ab

| Span                          | Count | Avg ms |
|-------------------------------|-------|--------|
| cart_merge.load_items         |  127  |   18.4 |
| cart_merge.load_item_variant  |   14  |   12.1 |
| cart_merge.flush              |    1  |    6.2 |

→ `load_item_variant` fires once per cart_item — classic N+1.
→ Suggested fix: prefetch via `load_items_with_variants(ids)`.

(See `flow_sdk/cart/loader.py:124` for the offending loop.)
"""

FAKE_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000080000000808060000007339"
    "23380000000a49444154789c63000100000005000146a9b0e30000000049454e44ae426082"
)


async def main() -> int:
    t0 = time.monotonic()

    async with httpx.AsyncClient(timeout=10.0) as h:
        r = await h.get(f"{LOCAL_API}/cloud/status")
        r.raise_for_status()
        if not (r.json().get("data") or {}).get("logged_in"):
            print("ERROR: alice's local backend is not cloud-logged-in. "
                  "Run `curl -X POST http://localhost:9008/api/v1/cloud/login` first.",
                  file=sys.stderr)
            return 2

        print("[1/12] creating local entities — Specs, Skills, Tasks, AgenticProcess...")
        brief_spec_id = await _create_spec(
            h, title="Brief: Real-time read receipts", content=BRIEF_SPEC, spec_type="issue",
        )
        arch_spec_id = await _create_spec(
            h, title="Architecture: read-receipt fanout", content=ARCHITECTURE_SPEC, spec_type="plan",
        )
        analyzer_skill_id = await _create_skill(
            h, name="n+1-query-analyzer", description="Surface N+1 query patterns in a trace bundle",
        )
        regress_skill_id = await _create_skill(
            h, name="regression-test-coverage", description="Generate Hypothesis-style regression tests for a symbol",
        )
        hub_task_id = await _create_task(
            h, title="Wire body_status into MessageBubble chip state",
        )
        migr_task_id = await _create_task(
            h, title="Hub migration: default body_status=NA for legacy FMs",
        )
        # The "result" of running the analyzer skill — a real AgenticProcess
        # entity we can attach to bob's "ran it" reply so the chip is live.
        analyzer_run_id = await _create_agentic_process(
            h, title="n+1-query-analyzer · checkout-canary run",
        )

        # Shared context: the brief is the conv-level pin.
        shared_ctx: list[dict[str, str]] = [{"type": "spec", "id": brief_spec_id}]

        print("[2/12] creating conversation with shared context + sharing with bob...")
        conv_id = await _create_conversation(
            h, title="Read receipts — design + ship",
            context_entities=[f"spec-{brief_spec_id}"],  # SHARED
        )
        try:
            await _share_conv(h, conv_id, [BOB_EMAIL])
        except httpx.HTTPStatusError as e:
            print(f"  share warning (non-fatal): {e.response.status_code} {e.response.text[:200]}")

        # ── messages ──────────────────────────────────────────────────────
        print("[3/12] msg 1 — alice opens with the brief + Figma frames.")
        await _add_message(
            h, conv_id,
            sender_name="Alice",
            text=(
                "Kicking off read receipts. Brief is attached — three states "
                "(sent · delivered · read) plus a privacy gate. Figma frames "
                "show the glyph treatment. Bob, want you to own the hub fanout "
                "and the monotonic guard."
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"spec-{brief_spec_id}"},
                {"attachment_type": "url", "data": "https://figma.com/file/abc123/read-receipts"},
            ],
            # No private ctx: this msg sets the agenda; everything's still
            # in the shared row.
        )

        print("[4/12] msg 2 — bob acknowledges + asks for the architecture call.")
        await _add_message(
            h, conv_id,
            sender_name="Bob",
            text=(
                "On it. Will sketch the fanout path against the existing "
                "Conversation._fanout_message and post an architecture doc "
                "in an hour. Repo URL for my own bookmark."
            ),
            attachment=[
                {"attachment_type": "url", "data": DEMO_REPO_URL},
            ],
        )

        print("[5/12] msg 3 — alice ships a wireframe + voice note (FILE body).")
        fm3 = await _add_message(
            h, conv_id,
            sender_name="Alice",
            text=(
                "Wireframe of the glyph treatment + a 30-second voice note "
                "walking through the WhatsApp comparison — left side is sent, "
                "middle is delivered, right side is read with the blue tick."
            ),
            attachment=[
                {"attachment_type": "file", "data": "data/wireframe.png"},
                {"attachment_type": "file", "data": "data/voice-note.m4a"},
                {"attachment_type": "url", "data": "https://faq.whatsapp.com/blue-ticks"},
            ],
        )
        fm3_id = fm3["id"]
        await _stage_file(fm3_id, "data/wireframe.png", FAKE_PNG)
        await _stage_file(fm3_id, "data/voice-note.m4a", b"ID3\x04\x00 fake voice note - 1024 samples")
        upload_res = await _upload_body(fm3_id)
        print(f"        body uploaded: status={upload_res.get('body_status')} filename={upload_res.get('attachment_filename')}")

        print("[6/12] msg 4 — bob attaches the architecture spec + spawns two tasks (PRIVATE ctx).")
        await _add_message(
            h, conv_id,
            sender_name="Bob",
            text=(
                "Architecture doc attached. I broke it into two tasks — one "
                "for the hub-side chip wiring, one for the migration that "
                "defaults legacy rows to body_status=NA. Both are mine."
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"spec-{arch_spec_id}"},
                {"attachment_type": "type_id", "data": f"task-{hub_task_id}"},
                {"attachment_type": "type_id", "data": f"task-{migr_task_id}"},
            ],
            # Private: these tasks belong to *this* message, not the whole conv.
            context_entities=[
                f"task-{hub_task_id}",
                f"task-{migr_task_id}",
            ],
        )

        print("[7/12] msg 5 — bob proposes a prompt to run the analyzer (inline PROMPT).")
        await _add_message(
            h, conv_id,
            sender_name="Bob",
            text=(
                "Before I touch the migration, want me to run the N+1 analyzer "
                "on yesterday's cart-merge canary traces? Approve and I'll "
                "execute it headlessly."
            ),
            attachment=[
                {
                    "attachment_type": "prompt",
                    "data": (
                        "Run the n+1-query-analyzer skill against the cart-merge "
                        "canary trace bundle from 2026-05-13 14:00-14:30 UTC. "
                        "Output: top-3 hot clusters with file:line refs and a "
                        "suggested batched-loader fix."
                    ),
                },
                {"attachment_type": "type_id", "data": f"skill-{analyzer_skill_id}"},
            ],
        )

        print("[8/12] msg 6 — alice approves, attaches the trace bundle PROMPT-with-file.")
        fm6 = await _add_message(
            h, conv_id,
            sender_name="Alice",
            text=(
                "Approved. Here's the curated extraction prompt I've been "
                "using — feel free to tweak. Use the dashboard for the "
                "raw window."
            ),
            attachment=[
                {"attachment_type": "prompt", "data": "prompt/trace-extract.md"},
                {"attachment_type": "url", "data": "https://grafana.internal/d/api-latency"},
            ],
        )
        fm6_id = fm6["id"]
        await _stage_file(
            fm6_id,
            "prompt/trace-extract.md",
            (
                "# Trace extraction prompt\n\n"
                "Given a Grafana trace bundle, surface the top-N candidates that\n"
                "match an N+1 pattern. Output: file:line refs + count per trace,\n"
                "grouped by route. Skip spans < 5ms (noise)."
            ).encode(),
        )
        await _upload_body(fm6_id)

        print("[9/12] msg 7 — bob posts the run result (AgenticProcess + output FILE; PRIVATE ctx to msg 5).")
        fm7 = await _add_message(
            h, conv_id,
            sender_name="Bob",
            text=(
                "Done — analyzer pinned three hot clusters, all in "
                "cart_merge.load_item_variant. Full output attached, run "
                "session linked. Classic N+1; want me to fold the fix into "
                "the migration task or split it off?"
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"agentic_process-{analyzer_run_id}"},
                {"attachment_type": "file", "data": "data/analyzer-output.md"},
            ],
            # Private context: this msg is the result of msg 5's prompt,
            # spawned the run shown in the AP chip.
            context_entities=[
                f"agentic_process-{analyzer_run_id}",
            ],
        )
        fm7_id = fm7["id"]
        await _stage_file(fm7_id, "data/analyzer-output.md", ANALYZER_OUTPUT.encode())
        await _upload_body(fm7_id)

        print("[10/12] msg 8 — alice reroutes the hub task to include the loader fix.")
        await _add_message(
            h, conv_id,
            sender_name="Alice",
            text=(
                "Fold it into the hub task — same PR. Renaming the task "
                "scope so it's obvious in standup. Also picking the regression "
                "skill so we lock the loader behavior down before it ships."
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"task-{hub_task_id}"},
                {"attachment_type": "type_id", "data": f"skill-{regress_skill_id}"},
            ],
            # Private context: this msg ties back to bob's run result.
            context_entities=[
                f"task-{hub_task_id}",
                f"flow_message-{fm7_id}",
            ],
        )

        print("[11/12] msg 9 — bob posts the review checklist + test/rollout plans (FILE body).")
        fm9 = await _add_message(
            h, conv_id,
            sender_name="Bob",
            text=(
                "Checklist + test plan + rollout. PR is up — opening a review "
                "thread now. Take a look at the checklist before I tag review."
            ),
            attachment=[
                {
                    "attachment_type": "prompt",
                    "data": (
                        "Walk through the review checklist line-by-line and "
                        "call out anything we haven't covered. Don't write "
                        "code yet — just gaps."
                    ),
                },
                {"attachment_type": "file", "data": "data/review-checklist.md"},
                {"attachment_type": "file", "data": "data/test-plan.md"},
                {"attachment_type": "file", "data": "data/rollout-plan.md"},
            ],
            context_entities=[
                f"task-{hub_task_id}",
            ],
        )
        fm9_id = fm9["id"]
        await _stage_file(fm9_id, "data/review-checklist.md", REVIEW_CHECKLIST.encode())
        await _stage_file(fm9_id, "data/test-plan.md", TEST_PLAN.encode())
        await _stage_file(fm9_id, "data/rollout-plan.md", ROLLOUT_PLAN.encode())
        await _upload_body(fm9_id)

        print("[12/12] msg 10 — alice posts PR + closes the loop.")
        await _add_message(
            h, conv_id,
            sender_name="Alice",
            text=(
                "PR looks great — approved. Canary at 10% from now; if p99 "
                "stays under 80ms for 24h I'll flip to 100%. Architecture "
                "doc + run output linked for the postmortem-style writeup. 👍"
            ),
            attachment=[
                {"attachment_type": "url", "data": "https://github.com/flowpad/flowpad-oss/pull/4242"},
                {"attachment_type": "type_id", "data": f"spec-{arch_spec_id}"},
            ],
            context_entities=[
                f"task-{hub_task_id}",
                f"flow_message-{fm7_id}",
            ],
        )

    elapsed = (time.monotonic() - t0) * 1000
    print()
    print("=" * 76)
    print(f"✓ Rich demo conversation seeded in {elapsed:.0f} ms")
    print()
    print(f"  conv id : {conv_id}")
    print(f"  UI URL  : http://localhost:4098/dock/conversation/{conv_id}")
    print(f"  open as : {ALICE_EMAIL}")
    print()
    print("  Story:   brief → ack → wireframe → architecture+tasks → prompt →")
    print("           approve → run-result → re-scope → review → ship")
    print("  Covers:  Spec · Skill · Task · AgenticProcess · URL · REPO · FILE ·")
    print("           inline PROMPT · PROMPT-with-file · body_status NA→READY ·")
    print("           shared conv context (Brief Spec) · per-msg private context")
    print("           (Tasks / AgenticProcess / prior FlowMessages).")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
