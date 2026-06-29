#!/usr/bin/env python3
"""Sales demo: Alice ↔ Bob production-incident conversation, rich edition.

Seeds a 9-message conversation between Alice and Bob that walks through a full
incident → diagnosis → fix → ship loop, exchanging real flowpad AI assets:

  • Spec (issue)   — Alice's incident report
  • Spec (plan)    — Alice's fix plan
  • Skill          — Bob's N+1 trace analyzer
  • Skill          — Bob's regression-test generator
  • URL            — dashboards, PR
  • REPO           — repo path
  • PROMPT         — Bob's "Approve & Run" prompts (skill invocations)

Real local entities (Skills + Specs) are created on Alice's local backend so
the attachment chips in her UI resolve to actual openable artifacts. Messages
also bind to context_entities so the incident Spec acts as the through-line.

Story beats:
    1. Alice → Bob   incident spec + dashboard URL
    2. Bob   → Alice ask for trace IDs
    3. Alice → Bob   trace IDs + repo pointer
    4. Bob   → Alice analysis Skill + Approve & Run prompt
    5. Alice → Bob   skill output, root cause
    6. Alice → Bob   fix plan spec
    7. Bob   → Alice regression-test Skill
    8. Alice → Bob   PR url, canary rolled back
    9. Bob   → Alice ack + postmortem ask

Usage:
    # Local backend (port 9008) AND hub (default 8093) must be running
    uv run python scripts/demo_alice_bob_prod_incident.py

Env:
    LOCAL_BACKEND_URL   default http://localhost:9008
    FLOWPAD_HUB_URL     default http://localhost:8093
    DEMO_ALICE_EMAIL    default alice@local.test
    DEMO_ALICE_PW       default alice-pw-1234
    DEMO_BOB_EMAIL      default bob@local.test
    DEMO_BOB_PW         default bob-pw-1234
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, Callable

import httpx
import websockets


from pathlib import Path
import sqlite3

LOCAL_URL = os.environ.get("LOCAL_BACKEND_URL", "http://localhost:9008").rstrip("/")
LOCAL_API = f"{LOCAL_URL}/api/v1"
HUB_URL = os.environ.get("FLOWPAD_HUB_URL", "http://localhost:8093").rstrip("/")
API_BASE = f"{HUB_URL}/api/v1"

# Local server DB + records path (must match the running backend's resolved
# paths — see flow_sdk/instance_settings/base_settings.py).
LOCAL_DB_PATH = Path(os.environ.get("SQLITE_DATABASE_PATH", str(Path.home() / ".flow/db/flowpad_db")))
LOCAL_RECORDS_ROOT = Path(os.environ.get("FS_RECORD_PATH", str(Path.home() / ".flow/records")))

ALICE_EMAIL = os.environ.get("DEMO_ALICE_EMAIL", "alice@local.test")
ALICE_PW = os.environ.get("DEMO_ALICE_PW", "alice-pw-1234")
BOB_EMAIL = os.environ.get("DEMO_BOB_EMAIL", "bob@local.test")
BOB_PW = os.environ.get("DEMO_BOB_PW", "bob-pw-1234")

REPO_PATH = str(Path(__file__).resolve().parents[1])


# --- local entity creation -------------------------------------------------

async def _create_local_skill(http: httpx.AsyncClient, name: str, description: str) -> str:
    resp = await http.post(f"{LOCAL_API}/graph/skill", json={"name": name, "description": description})
    if resp.status_code != 200:
        raise RuntimeError(f"create skill {name!r} failed: {resp.status_code} {resp.text}")
    return ((resp.json() or {}).get("data") or {}).get("id")


async def _create_local_spec(
    http: httpx.AsyncClient, *, title: str, content: str, spec_type: str
) -> str:
    resp = await http.post(
        f"{LOCAL_API}/graph/spec",
        json={"title": title, "content": content, "spec_type": spec_type},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"create spec {title!r} failed: {resp.status_code} {resp.text}")
    return ((resp.json() or {}).get("data") or {}).get("id")


# --- hub auth helpers (from realtime_alice_bob_demo.py) --------------------

async def _signup_if_missing(http: httpx.AsyncClient, email: str, password: str, first_name: str) -> None:
    try:
        await http.post(
            f"{API_BASE}/signup",
            json={"email": email, "password": password, "first_name": first_name, "last_name": "Demo"},
        )
    except Exception:
        pass


async def _login(http: httpx.AsyncClient, email: str, password: str) -> tuple[str, str]:
    resp = await http.post(f"{API_BASE}/login", json={"email": email, "password": password})
    if resp.status_code != 200:
        raise RuntimeError(f"login {email} failed: {resp.status_code} {resp.text}")
    data = (resp.json() or {}).get("data") or {}
    token = data.get("token")
    user = data.get("user") or {}
    if not token or not user.get("id"):
        raise RuntimeError(f"bad login response for {email}: {resp.text}")
    return token, user["id"]


async def _create_project(http: httpx.AsyncClient, alice_token: str, title: str) -> str:
    # Allow reusing an existing project — handy when the hub's stale-connection
    # lookup transiently blocks new POST /graph/project (the bug emits a 404
    # "Missing resource. Exception: No connection_service found for connections
    # (>1min old): connection-…"). Set DEMO_PROJECT_ID to skip the create.
    override = os.environ.get("DEMO_PROJECT_ID")
    if override:
        return override
    resp = await http.post(
        f"{API_BASE}/graph/project",
        json={"title": title},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    if resp.status_code != 200:
        # Fallback: pick an existing project with the same title.
        listing = await http.get(
            f"{API_BASE}/graph/project",
            headers={"Authorization": f"Bearer {alice_token}"},
        )
        if listing.status_code == 200:
            for p in (listing.json() or {}).get("data") or []:
                if p.get("title") == title and p.get("id"):
                    print(f"  ! POST /project failed ({resp.status_code}); reusing existing {p['id']}")
                    return p["id"]
        raise RuntimeError(f"create project failed: {resp.status_code} {resp.text}")
    pid = ((resp.json() or {}).get("data") or {}).get("id")
    if not pid:
        raise RuntimeError(f"no project id: {resp.text}")
    return pid


async def _enable_guest(http: httpx.AsyncClient, alice_token: str, project_id: str) -> None:
    resp = await http.post(
        f"{API_BASE}/graph/project/{project_id}/enable_guest_conversations",
        json={"enabled": True},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"enable_guest failed: {resp.status_code} {resp.text}")


# --- WS helpers ------------------------------------------------------------

def _ws_url(connection_id: str) -> str:
    base = HUB_URL.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/api/v1/connect/ws/{connection_id}"


async def _open_ws(token: str, connection_id: str):
    return await websockets.connect(
        _ws_url(connection_id),
        additional_headers={"Authorization": f"Bearer {token}"},
        open_timeout=10.0,
    )


async def _drain_until(ws, predicate: Callable[[dict], bool], timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"predicate not satisfied within {timeout}s")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        if not isinstance(raw, str):
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and predicate(obj):
            return obj


def _is_response_for(message_id: str) -> Callable[[dict], bool]:
    def _check(obj: dict) -> bool:
        if obj.get("request_id") == message_id:
            return True
        if obj.get("message_type") == "response_msg":
            return obj.get("response_message_id") == message_id or obj.get("message_id") == message_id
        return False
    return _check


def _unwrap_response_data(resp: dict) -> dict:
    if "request_id" in resp and "data" in resp and resp.get("message_type") != "response_msg":
        return resp["data"] if isinstance(resp["data"], dict) else {}
    content = resp.get("content")
    if isinstance(content, dict) and "data" in content:
        return content["data"] if isinstance(content["data"], dict) else {}
    if isinstance(content, dict):
        return content
    if "data" in resp and isinstance(resp["data"], dict):
        return resp["data"]
    return resp


def _to_entity_matches(obj: Any, etype: str, eid: str | None = None) -> bool:
    target = obj.get("to_entity") if isinstance(obj, dict) else None
    if isinstance(target, dict):
        if target.get("type") != etype:
            return False
        if eid and target.get("id") != eid:
            return False
        return True
    if isinstance(target, str):
        for sep in ("-", ":"):
            if target.startswith(f"{etype}{sep}"):
                if eid is None:
                    return True
                return target.split(sep, 1)[1] == eid
    return False


def _is_data_op(op_value: str, etype: str, eid: str | None = None) -> Callable[[dict], bool]:
    def _check(obj: dict) -> bool:
        if obj.get("message_type") != "data_op_msg":
            return False
        if str(obj.get("op", "")).lower() != op_value:
            return False
        return _to_entity_matches(obj, etype, eid)
    return _check


def _extract_to_entity_id(obj: dict) -> str | None:
    target = obj.get("to_entity")
    if isinstance(target, dict):
        return target.get("id")
    if isinstance(target, str):
        for sep in ("-", ":"):
            if sep in target:
                return target.split(sep, 1)[1]
    return None


async def _ws_send_request(ws, payload: dict, timeout: float = 5.0) -> dict:
    payload.setdefault("message_id", str(uuid.uuid4()))
    await ws.send(json.dumps(payload))
    return await _drain_until(ws, _is_response_for(payload["message_id"]), timeout=timeout)


# --- per-message helper ----------------------------------------------------

async def _post_message(
    sender_ws,
    recipient_ws,
    *,
    conv_id: str,
    sender_name: str,
    text: str,
    attachment: list[dict] | None = None,
    context: list[dict] | None = None,
) -> str:
    """add_message → recipient sees create → recipient marks delivered+received."""
    body: dict = {"text": text, "sender_name": sender_name}
    if attachment:
        body["attachment"] = attachment
    if context:
        # Hub-side FlowMessage uses ``context`` (list[TypeId]); flow_sdk-side
        # uses ``context_entities``. Send both — the unknown one is ignored.
        body["context"] = context
        body["context_entities"] = context

    await _ws_send_request(
        sender_ws,
        {
            "message_type": "rest_api_msg",
            "method": "POST",
            "scope": [],
            "target_typeid": {"type": "conversation", "id": conv_id},
            "action": "add_message",
            "body": body,
        },
        timeout=5.0,
    )
    create = await _drain_until(recipient_ws, _is_data_op("create", "flow_message"), timeout=5.0)
    fm_id = _extract_to_entity_id(create)
    if not fm_id:
        raise RuntimeError("recipient did not see create for new message")
    for action_name in ("mark_delivered", "mark_received"):
        await _ws_send_request(
            recipient_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "direct_resource_type": "flow_message",
                "action": action_name,
                "body": {"flow_message_ids": [fm_id]},
            },
            timeout=5.0,
        )
    return fm_id


# --- content ---------------------------------------------------------------

INCIDENT_SPEC = """# Incident: checkout-api p99 latency spike

**Severity:** SEV-2  (slow, not failing)
**Window:** 2026-05-13 14:03 UTC → ongoing
**Surface:** POST /checkout/finalize

## What we're seeing
- p99 latency: **80ms → 4.2s** (52× regression)
- p50 latency: 45ms → 380ms
- Error rate: **0.2%** (unchanged — requests succeed, just slow)
- Affected endpoints: `/checkout/finalize`, `/cart/merge`

## Timeline
- 13:45 UTC — v2.41 deployed to canary (10% of traffic)
- 14:03 UTC — first latency alert fires (p99 > 1s threshold)
- 14:08 UTC — alert escalates, opening this thread

## Hypotheses
1. New cart-merge query path added in v2.41 — most likely
2. DB connection pool exhaustion on the canary instance
3. Upstream product-catalog service degradation (low likelihood — its dashboards are clean)

## Ask
Need eyes on the cart-merge code path and any new queries v2.41 introduced.
"""

FIX_PLAN_SPEC = """# Fix Plan: batch enrich_cart_lines + regression coverage

**Root cause:** `enrich_cart_lines()` in `cart_service.py:142` issues one
product-lookup query per cart line (N+1). An 8-item cart fires 8 sequential
500ms queries → 4s tail latency.

## Fix
1. Replace per-line `product_repo.get(line.sku)` with the existing
   `product_repo.batched_lookup(skus)` (already used in `inventory_service.py`).
2. Single query for all SKUs in a cart, regardless of size.

## Rollout
1. Roll v2.41 canary back to v2.40  (immediate, ~2 min)
2. Land patch on `release/v2.41-hotfix` branch
3. Add regression test (property-based, see below)
4. Re-canary at 10%, watch p99 for 30 min, then 100%

## Regression test (new)
Property test: for any cart with N line items (N ∈ [1, 1000]):
- `enrich_cart_lines(cart)` issues **≤ 2** DB calls total
- Result is identical to the per-line version (correctness)

## Estimate
~45 min total: 10 min patch, 20 min test, 15 min canary watch.
"""

TRACE_ANALYZER_DESCRIPTION = (
    "Analyzes service logs for N+1 query patterns and tail-latency outliers. "
    "Groups by trace_id, surfaces repeat queries inside a single trace, and "
    "correlates slow traces with deploy headers. Output: top-N root-cause "
    "candidates with file:line refs."
)

REGRESSION_COVERAGE_DESCRIPTION = (
    "Generates property-based regression tests for a given function symbol. "
    "Infers invariants from existing call sites + type signatures, emits "
    "Hypothesis-style strategies. Used for the inventory-merge bug last sprint."
)

ANALYZER_PROMPT = (
    "Run trace-n-plus-one against traces tr_a1b2, tr_c3d4, tr_e5f6 in the "
    "checkout-api log window 2026-05-13T14:00Z–14:10Z. Surface the top-3 "
    "N+1 candidates with file:line refs and the suggested batched alternative. "
    "Filter on header x-deploy-id=v2.41-canary."
)


# --- local SQLite backfill (post-seed) -------------------------------------

async def _wait_for_message_count(conv_id: str, *, expected: int, timeout: float) -> int:
    """Poll SQLite until `expected` flow_message rows exist for `conv_id`."""
    deadline = time.monotonic() + timeout
    last = 0
    while time.monotonic() < deadline:
        if LOCAL_DB_PATH.exists():
            con = sqlite3.connect(str(LOCAL_DB_PATH))
            try:
                row = con.execute(
                    "SELECT count(*) FROM entities WHERE type='flow_message' "
                    "AND json_extract(data,'$.conversation_id') = ?",
                    (conv_id,),
                ).fetchone()
                last = row[0] if row else 0
            finally:
                con.close()
            if last >= expected:
                print(f"  ✓ {last}/{expected} flow_message rows materialized")
                return last
        await asyncio.sleep(0.4)
    print(f"  ! timeout waiting for materialization — got {last}/{expected}, proceeding anyway")
    return last


def _backfill_conversation_pointers(conv_id: str) -> None:
    """Rebuild Conversation.message_ids from the FlowMessage rows in SQLite.

    Closes the sender-skip gap: the hub-side fanout doesn't echo a sender's
    own messages back to their WS, so Alice's bridge never appends those
    pointers. We list every flow_message row for the conversation, order by
    created_date, write the canonical message_ids JSON onto the conversation
    entity, and emit a matching conversation.jsonl.
    """
    if not LOCAL_DB_PATH.exists():
        print(f"  ! SQLite not found at {LOCAL_DB_PATH} — skipping backfill")
        return
    con = sqlite3.connect(str(LOCAL_DB_PATH))
    try:
        rows = con.execute(
            """
            SELECT id, created_date FROM entities
            WHERE type='flow_message'
              AND json_extract(data,'$.conversation_id') = ?
            ORDER BY created_date
            """,
            (conv_id,),
        ).fetchall()
        if not rows:
            print("  ! no flow_message rows found for conversation — skipping")
            return

        def iso(ts: str) -> str:
            ts = ts.replace(" ", "T")
            if "+" not in ts and "Z" not in ts:
                ts += "+00:00"
            return ts

        pointers = [{"typeid": f"flow_message-{fm_id}", "ts": iso(ts)} for fm_id, ts in rows]

        conv_row = con.execute(
            "SELECT data FROM entities WHERE type='conversation' AND id=?",
            (conv_id,),
        ).fetchone()
        if not conv_row:
            print("  ! conversation row missing — skipping")
            return
        data = json.loads(conv_row[0])
        data["message_ids"] = json.dumps(pointers)
        data["message_count"] = len(pointers)
        con.execute(
            "UPDATE entities SET data=? WHERE type='conversation' AND id=?",
            (json.dumps(data), conv_id),
        )
        con.commit()

        jsonl_dir = LOCAL_RECORDS_ROOT / "conversation" / f"conversation-@{conv_id}"
        jsonl_dir.mkdir(parents=True, exist_ok=True)
        jsonl_path = jsonl_dir / "conversation.jsonl"
        with jsonl_path.open("w") as f:
            for p in pointers:
                f.write(json.dumps(p) + "\n")
        print(f"  ✓ {len(pointers)} pointers → message_ids + {jsonl_path.name}")
    finally:
        con.close()


# --- demo flow -------------------------------------------------------------

async def _run_demo() -> int:
    print(f"local backend : {LOCAL_URL}")
    print(f"hub           : {HUB_URL}")
    print()

    # Phase 1: create real local entities on Alice's side -------------------
    async with httpx.AsyncClient(timeout=10.0) as local:
        print("[setup] creating local AI assets (skills + specs)…")
        analyzer_skill_id = await _create_local_skill(
            local, "trace-n-plus-one", TRACE_ANALYZER_DESCRIPTION
        )
        regression_skill_id = await _create_local_skill(
            local, "regression-test-coverage", REGRESSION_COVERAGE_DESCRIPTION
        )
        incident_spec_id = await _create_local_spec(
            local,
            title="Incident: checkout-api p99 spike (2026-05-13 14:03Z)",
            content=INCIDENT_SPEC,
            spec_type="issue",
        )
        fix_plan_spec_id = await _create_local_spec(
            local,
            title="Plan: batch enrich_cart_lines + regression coverage",
            content=FIX_PLAN_SPEC,
            spec_type="plan",
        )
        print(f"  skill (analyzer)   : skill-{analyzer_skill_id}")
        print(f"  skill (regression) : skill-{regression_skill_id}")
        print(f"  spec  (incident)   : spec-{incident_spec_id}")
        print(f"  spec  (fix plan)   : spec-{fix_plan_spec_id}")

    # Phase 2: hub auth + project -------------------------------------------
    async with httpx.AsyncClient(timeout=10.0) as hub:
        await _signup_if_missing(hub, ALICE_EMAIL, ALICE_PW, "Alice")
        await _signup_if_missing(hub, BOB_EMAIL, BOB_PW, "Bob")
        alice_token, alice_id = await _login(hub, ALICE_EMAIL, ALICE_PW)
        bob_token, bob_id = await _login(hub, BOB_EMAIL, BOB_PW)
        project_id = await _create_project(hub, alice_token, "checkout-api incident demo")
        await _enable_guest(hub, alice_token, project_id)

    print()
    print(f"alice (hub)   : {ALICE_EMAIL} ({alice_id})")
    print(f"bob   (hub)   : {BOB_EMAIL} ({bob_id})")
    print(f"project       : {project_id}")
    print()

    alice_ws = await _open_ws(alice_token, f"demo-alice-{uuid.uuid4()}")
    bob_ws = await _open_ws(bob_token, f"demo-bob-{uuid.uuid4()}")

    # Convenience: TypeId dicts for context_entities and TYPE_ID attachments
    incident_ctx = {"type": "spec", "id": incident_spec_id}
    fix_plan_ctx = {"type": "spec", "id": fix_plan_spec_id}

    try:
        # ---------- msg 1: Alice → Bob — incident spec + dashboard --------
        print("[1/9] Alice opens conversation — incident spec + dashboard URL")
        resp = await _ws_send_request(
            alice_ws,
            {
                "message_type": "rest_api_msg",
                "method": "POST",
                "scope": [],
                "target_typeid": {"type": "project", "id": project_id},
                "action": "start_guest_conversation",
                "body": {
                    "text": (
                        "Bob — checkout-api p99 went from 80ms → 4.2s at 14:03 UTC. "
                        "Error rate is normal, just slow. v2.41 hit canary at 13:45. "
                        "Full incident report attached, plus the Datadog board. Take a look?"
                    ),
                    "sender_name": "Alice",
                    "receiver_address": bob_id,
                    "receiver_address_type": "id",
                    "attachment": [
                        {"attachment_type": "type_id", "data": f"spec-{incident_spec_id}"},
                        {
                            "attachment_type": "url",
                            "data": "https://datadog.example.com/dash/checkout-latency?from=14:00&to=15:00&deploy=v2.41-canary",
                        },
                    ],
                    "context": [incident_ctx],
                    "context_entities": [incident_ctx],
                },
            },
            timeout=5.0,
        )
        conv = _unwrap_response_data(resp)
        conv_id = conv.get("id")
        if not conv_id:
            raise RuntimeError(f"start_guest_conversation returned no conv id: {resp}")
        create = await _drain_until(bob_ws, _is_data_op("create", "flow_message"), timeout=5.0)
        fm1_id = _extract_to_entity_id(create)
        for action_name in ("mark_delivered", "mark_received"):
            await _ws_send_request(
                bob_ws,
                {
                    "message_type": "rest_api_msg",
                    "method": "POST",
                    "scope": [],
                    "direct_resource_type": "flow_message",
                    "action": action_name,
                    "body": {"flow_message_ids": [fm1_id]},
                },
                timeout=5.0,
            )

        # ---------- msg 2: Bob → Alice — ack, asks for traces -------------
        print("[2/9] Bob acknowledges — asks for trace IDs")
        await _post_message(
            bob_ws, alice_ws, conv_id=conv_id, sender_name="Bob",
            text=(
                "Read the spec. First instinct: v2.41 added a query in the cart-merge "
                "path that isn't batched. Need trace IDs to confirm — pull 2-3 with "
                "p99 > 3s from the last 10 minutes and drop them here."
            ),
            context=[incident_ctx],
        )

        # ---------- msg 3: Alice → Bob — traces + repo --------------------
        print("[3/9] Alice posts trace IDs + repo pointer")
        await _post_message(
            alice_ws, bob_ws, conv_id=conv_id, sender_name="Alice",
            text=(
                "Three samples, all on /checkout/finalize:\n"
                "  • tr_a1b2c3  — 4.2s, 8-item cart\n"
                "  • tr_c3d4e5  — 3.8s, 6-item cart\n"
                "  • tr_e5f6a7  — 4.6s, 11-item cart\n"
                "Latency scales with cart size — looks pattern-y. Repo:"
            ),
            attachment=[
                {"attachment_type": "repo", "data": REPO_PATH},
            ],
            context=[incident_ctx],
        )

        # ---------- msg 4: Bob → Alice — shares Skill + Approve&Run prompt
        print("[4/9] Bob shares N+1 analyzer skill + Approve & Run prompt")
        await _post_message(
            bob_ws, alice_ws, conv_id=conv_id, sender_name="Bob",
            text=(
                "Yep — latency-scales-with-N is the N+1 fingerprint. Sharing my "
                "trace-n-plus-one skill. Approve & Run the prompt below; it'll "
                "group queries by trace_id, surface repeat patterns, and point at "
                "the exact call site. Report drops in your workspace in ~30s."
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"skill-{analyzer_skill_id}"},
                {"attachment_type": "prompt", "data": ANALYZER_PROMPT},
            ],
            context=[incident_ctx],
        )

        # ---------- msg 5: Alice → Bob — skill output, root cause ---------
        print("[5/9] Alice reports skill output — root cause found")
        await _post_message(
            alice_ws, bob_ws, conv_id=conv_id, sender_name="Alice",
            text=(
                "Ran it. Skill output:\n"
                "\n"
                "  TOP-1  cart_service.py:142  enrich_cart_lines()\n"
                "         ↳ 8 sequential queries per cart, ~500ms each\n"
                "         ↳ batched alternative exists: product_repo.batched_lookup() (product_repo.py:88)\n"
                "  TOP-2  cart_service.py:201  recalc_totals()    — N=1, not the culprit\n"
                "  TOP-3  pricing_service.py:55 apply_promos()    — N=2 best case, fine\n"
                "\n"
                "All three slow traces hit TOP-1. Deploy correlation: 100% of slow "
                "traces carry x-deploy-id=v2.41-canary. Matches your hypothesis."
            ),
            context=[incident_ctx],
        )

        # ---------- msg 6: Alice → Bob — fix plan as Spec -----------------
        print("[6/9] Alice attaches the fix plan as a spec")
        await _post_message(
            alice_ws, bob_ws, conv_id=conv_id, sender_name="Alice",
            text=(
                "Drafted a fix plan — swap to batched_lookup(), add a property-based "
                "regression so this can't ship again. Plan attached. Reviewing-then-shipping?"
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"spec-{fix_plan_spec_id}"},
            ],
            context=[incident_ctx, fix_plan_ctx],
        )

        # ---------- msg 7: Bob → Alice — regression-test skill ------------
        print("[7/9] Bob shares regression-test-coverage skill")
        await _post_message(
            bob_ws, alice_ws, conv_id=conv_id, sender_name="Bob",
            text=(
                "Plan LGTM. One add: the regression should be a property test "
                "asserting ≤2 DB calls for ANY N, not just N=8. Sharing the "
                "regression-test-coverage skill we used on the inventory bug last "
                "sprint — point it at cart_service.py:142 and it'll generate the "
                "Hypothesis strategies for you."
            ),
            attachment=[
                {"attachment_type": "type_id", "data": f"skill-{regression_skill_id}"},
            ],
            context=[incident_ctx, fix_plan_ctx],
        )

        # ---------- msg 8: Alice → Bob — PR + canary rolled back ----------
        print("[8/9] Alice posts PR url + canary rollback status")
        await _post_message(
            alice_ws, bob_ws, conv_id=conv_id, sender_name="Alice",
            text=(
                "Ran regression-test-coverage on cart_service.py — generated 4 "
                "property tests covering N=1, 8, 32, 512. Canary rolled back to "
                "v2.40 at 14:31 UTC, p99 already settling back to 90ms. PR up:"
            ),
            attachment=[
                {"attachment_type": "url", "data": "https://github.com/flowpad/checkout-api/pull/4218"},
            ],
            context=[incident_ctx, fix_plan_ctx],
        )

        # ---------- msg 9: Bob → Alice — ship it + postmortem ------------
        print("[9/9] Bob acks — ship it, link convo in postmortem")
        await _post_message(
            bob_ws, alice_ws, conv_id=conv_id, sender_name="Bob",
            text=(
                "Reviewed — ship it. Nice catch keeping v2.41 on canary instead of "
                "rolling 100% this morning, that's the only reason this stayed SEV-2. "
                "Link this conversation in the postmortem doc — exemplary diagnosis path."
            ),
            context=[incident_ctx, fix_plan_ctx],
        )

    finally:
        await alice_ws.close()
        await bob_ws.close()

    # Phase 3: wait for Alice's bridge to finish materializing all 9 FlowMessage
    # rows. The bridge handles each create asynchronously; the last few often
    # land 1-3s after the WS round-trips finish.
    print()
    print("[backfill] waiting for bridge to materialize all rows…")
    await _wait_for_message_count(conv_id, expected=9, timeout=15.0)

    # Backfill Alice's own messages into her local conversation.message_ids.
    # The hub fans out flow_message CREATE only to non-senders, so Alice's bridge
    # never received her own outgoing messages — they're persisted as FlowMessage
    # rows (entity-save side-effect) but never got pointer-indexed onto the
    # Conversation. UI renders from message_ids → Alice's side appears half-empty
    # until we patch. Read-only demo: we patch SQLite + write conversation.jsonl
    # directly. Idempotent — re-runs just rewrite the same canonical order.
    print()
    print("[backfill] patching local conversation.message_ids…")
    _backfill_conversation_pointers(conv_id)

    print()
    print("✓ Demo conversation seeded.")
    print(f"  conversation id : {conv_id}")
    print(f"  UI URL          : http://localhost:4098/dock/conversation/{conv_id}")
    print(f"  open as         : {ALICE_EMAIL}  (auto-login already configured)")
    return 0


def main() -> int:
    try:
        return asyncio.run(_run_demo())
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"\nDEMO FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
