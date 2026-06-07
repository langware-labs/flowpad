#!/usr/bin/env python3
"""Enriched sales demo: Alice ↔ Bob production-incident conversation.

Builds an 11-message conversation showcasing the full spread of flowpad
"AI asset exchanges": Specs, Skills, Agents, real binary files, and
per-message Private Context (Tasks + AgenticProcess sessions).

Goes 100% local (no hub) — every entity is created on the running
local backend, every message lives in /tmp/flowpad_dev.db. Read-only
demo: no delivery receipts, but every chip + sidebar context resolves.

Asset spread:
    • 3 Skills          — trace-n-plus-one, blast-radius-checker, regression-test-coverage
    • 1 Agent           — checkout-incident-responder    ← NEW (share an agent)
    • 2 Specs (shared)  — incident report, fix plan
    • 1 Spec (private)  — postmortem template            ← only on Alice's side
    • 2 FILE attachments — trace_excerpt.log, p99_latency_graph.txt, PR_changes_summary.md
    • 1 REPO attachment  — flowpad-oss
    • 2 URL attachments  — Datadog, PR
    • 2 PROMPT chips     — Approve & Execute (skill invocations)
    • 2 Tasks            — private context per FlowMessage
    • 1 AgenticProcess   — represents the trace-analyzer headless run

Usage:
    uv run python scripts/demo_alice_bob_enriched.py

Prereqs:
    Local backend on $LOCAL_SERVER_PORT (default 9008). DB is auto-detected
    from the server's bootstrap response (no hard-coded path).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx


LOCAL_URL = os.environ.get("LOCAL_BACKEND_URL", "http://localhost:9008").rstrip("/")
LOCAL_API = f"{LOCAL_URL}/api/v1"

# Where the running server keeps state. Two DB candidates we've seen on this
# box (see project memory hub_sender_skip_pattern). Probe both, prefer the
# one the live server writes to.
DB_CANDIDATES = [
    Path("/tmp/flowpad_dev.db"),
    Path.home() / ".flow/db/flowpad_db",
]
RECORDS_ROOT = Path.home() / ".flow/records"
EMBEDDED_STORAGE_ROOT = Path(tempfile.gettempdir()) / "flow-embedded-storage"


# --- HTTP helpers ----------------------------------------------------------

def post_entity(http: httpx.Client, type_: str, body: dict) -> str:
    r = http.post(f"{LOCAL_API}/graph/{type_}", json=body)
    r.raise_for_status()
    eid = (r.json().get("data") or {}).get("id")
    if not eid:
        raise RuntimeError(f"{type_} create returned no id: {r.text}")
    return eid


def detect_active_db(http: httpx.Client) -> Path:
    """Find which SQLite the live server is writing to.

    POST a throwaway spec, then check each candidate DB for it. The one
    that has the row is the active DB.
    """
    probe = post_entity(http, "spec", {"title": "_db-probe", "content": "x", "spec_type": "issue"})
    try:
        for db in DB_CANDIDATES:
            if not db.exists():
                continue
            con = sqlite3.connect(str(db), timeout=5)
            row = con.execute(
                "SELECT 1 FROM entities WHERE id=? AND type='spec'", (probe,)
            ).fetchone()
            con.close()
            if row:
                return db
        raise RuntimeError(f"probe spec {probe} not found in any candidate DB")
    finally:
        http.delete(f"{LOCAL_API}/graph/spec/{probe}")


# --- Local SQLite helpers --------------------------------------------------

def with_retry(con: sqlite3.Connection, sql: str, params: tuple) -> None:
    for _ in range(8):
        try:
            con.execute(sql, params)
            con.commit()
            return
        except sqlite3.OperationalError as e:
            if "locked" in str(e):
                time.sleep(0.5)
            else:
                raise
    raise RuntimeError(f"SQLite locked after retries: {sql[:60]}")


# --- Content ---------------------------------------------------------------

INCIDENT_SPEC = """# Incident: checkout-api p99 latency spike

**Severity:** SEV-2  (slow, not failing)
**Window:** 2026-05-17 14:03 UTC → ongoing
**Surface:** POST /checkout/finalize

## What we're seeing
- p99 latency: **80ms → 4.2s** (52× regression)
- p50: 45ms → 380ms
- Error rate: **0.2%** (unchanged — requests succeed, just slow)

## Timeline
- 13:45 UTC — v2.41 deployed to canary (10% of traffic)
- 14:03 UTC — first latency alert fires
- 14:08 UTC — incident thread opened

## Hypotheses
1. New cart-merge query path in v2.41 — most likely
2. DB connection pool exhaustion on canary
3. Upstream product-catalog degradation — low likelihood
"""

FIX_PLAN_SPEC = """# Fix Plan: batch enrich_cart_lines + regression coverage

**Root cause:** `enrich_cart_lines()` in `cart_service.py:142` issues one
product-lookup query per cart line (N+1). 8-item cart → 8 × 500ms.

## Fix
1. Replace per-line `product_repo.get(line.sku)` with the existing
   `product_repo.batched_lookup(skus)`.
2. Single query for all SKUs regardless of cart size.

## Rollout
1. Roll v2.41 canary back to v2.40 (~2 min)
2. Land patch on `release/v2.41-hotfix`
3. Add property-based regression test
4. Re-canary at 10%, watch p99 for 30 min, then 100%
"""

POSTMORTEM_TEMPLATE = """# Postmortem (private draft)

> Alice's working notes — not shared with Bob yet.

## What happened (1 paragraph)
…

## Detection
- alert: datadog p99-latency-checkout
- time-to-detect: 18 min (acceptable)

## Resolution
- canary rolled back at 14:31 UTC
- batched-lookup patch shipped at 15:12 UTC
- p99 back to 90ms by 15:18 UTC
- time-to-resolution: 75 min

## Action items
- [ ] add property-test asserting ≤2 DB calls per cart-merge
- [ ] tighten canary auto-rollback threshold to 2× p99
- [ ] add deploy-correlation column to the latency dashboard

## What went well / poorly
…
"""

AGENT_BODY = """---
name: checkout-incident-responder
description: First-responder agent for checkout-api latency / availability incidents.
---

You are an on-call SRE assistant for the checkout-api service. When invoked:

1. Pull the latest 10 minutes of error logs and trace samples
2. Cross-reference recent deploys against the alert window
3. Surface the top-3 most-likely root-cause hypotheses with evidence
4. Propose a one-line rollback command if the deploy correlation is >80%

Tools you have: log_search, trace_query, deploy_history, dashboard_screenshot.
Output format: structured Markdown, max 200 words.
"""

TRACE_EXCERPT_LOG = """2026-05-17T14:03:11.224Z  INFO   trace_id=tr_a1b2c3 POST /checkout/finalize cart_size=8
2026-05-17T14:03:11.225Z  DEBUG  trace_id=tr_a1b2c3 cart_service.py:142 enrich_cart_lines() begin
2026-05-17T14:03:11.731Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0091) → 506ms
2026-05-17T14:03:12.237Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0188) → 502ms
2026-05-17T14:03:12.743Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0274) → 504ms
2026-05-17T14:03:13.249Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0356) → 502ms
2026-05-17T14:03:13.755Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0489) → 506ms
2026-05-17T14:03:14.261Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0531) → 504ms
2026-05-17T14:03:14.768Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0648) → 502ms
2026-05-17T14:03:15.273Z  DEBUG  trace_id=tr_a1b2c3 product_repo.py:55 get(sku=SKU-0712) → 505ms
2026-05-17T14:03:15.278Z  DEBUG  trace_id=tr_a1b2c3 cart_service.py:142 enrich_cart_lines() done (4053ms, 8 queries)
2026-05-17T14:03:15.281Z  INFO   trace_id=tr_a1b2c3 POST /checkout/finalize 200 4072ms
"""

P99_GRAPH_TXT = """p99 latency — checkout-api  (Datadog export, last 60 min)

ms
4500 │                                  ████████████████
4000 │                                ████████████████████
3500 │                              ████████████████████████
3000 │                            ██████████████████████████
2500 │                          ████████████████████████████
2000 │                        ██████████████████████████████
1500 │                      ████████████████████████████████
1000 │                    ██████████████████████████████████
 500 │                  ████████████████████████████████████
  80 │ ════════════════                                              ← baseline
     └────────────────┬─────────────────────────────────────────►
   13:00            13:45 (canary out)                     14:08 (now)

Blast radius (10% canary): ~6.4k req/s × 4s avg degradation = ~80 sec/req lost.
"""

PR_SUMMARY_MD = """# PR #4218 — Hotfix: batch enrich_cart_lines

## Changes
- `cart_service.py:142` — swap `product_repo.get(sku)` loop for
  `product_repo.batched_lookup(skus)` (single round-trip).
- `tests/test_cart_service.py` — 4 new property tests covering
  cart sizes N ∈ {1, 8, 32, 512} asserting **≤ 2** DB calls per merge.
- No schema changes. No API changes.

## Benchmark
| cart size | before  | after   | speedup |
|-----------|---------|---------|---------|
| 1         |  502 ms |  498 ms |   1.0×  |
| 8         | 4053 ms |  511 ms |   7.9×  |
| 32        | 16.1  s |  514 ms |  31.3×  |
| 128       | (timeout) | 528 ms | n/a   |

## Rollout plan
- canary 10% for 30 min, watch p99
- 100% if p99 holds <120ms
"""


def write_file_attachment(fm_id: str, filename: str, content: str) -> None:
    """Materialize a FILE attachment under the FlowMessage's embedded storage.
    Local UI resolves `local_path` via `get_entity_embedded_storage(typeid)`.
    """
    d = EMBEDDED_STORAGE_ROOT / "flow_message" / fm_id / "data"
    d.mkdir(parents=True, exist_ok=True)
    (d / filename).write_text(content)


# --- Main ------------------------------------------------------------------

def main() -> int:
    print(f"local backend : {LOCAL_URL}")
    http = httpx.Client(timeout=20.0)

    print("\n[setup] probing active DB…")
    db_path = detect_active_db(http)
    print(f"  active DB    : {db_path}")

    print("\n[setup] creating local AI assets…")
    skill_trace = post_entity(http, "skill", {
        "name": "trace-n-plus-one",
        "description": "Analyzes service logs for N+1 query patterns and tail-latency outliers. Groups by trace_id, surfaces repeat queries inside a single trace, and correlates slow traces with deploy headers. Output: top-N root-cause candidates with file:line refs.",
    })
    skill_blast = post_entity(http, "skill", {
        "name": "blast-radius-checker",
        "description": "Estimates user-facing impact of a degradation from a Datadog/Prometheus time-series window. Outputs lost-request-seconds + affected-user count + a one-line recommendation (continue / canary / rollback).",
    })
    skill_regr = post_entity(http, "skill", {
        "name": "regression-test-coverage",
        "description": "Generates property-based regression tests for a given function symbol. Infers invariants from existing call sites + type signatures, emits Hypothesis-style strategies.",
    })
    agent_responder = post_entity(http, "agent", {
        "name": "checkout-incident-responder",
        "description": "First-responder agent for checkout-api latency / availability incidents. Pulls logs, cross-references deploys, suggests a rollback command.",
    })
    spec_incident = post_entity(http, "spec", {
        "title": "Incident: checkout-api p99 spike (2026-05-17 14:03Z)",
        "content": INCIDENT_SPEC,
        "spec_type": "issue",
    })
    spec_fix = post_entity(http, "spec", {
        "title": "Plan: batch enrich_cart_lines + regression coverage",
        "content": FIX_PLAN_SPEC,
        "spec_type": "plan",
    })
    spec_postmortem = post_entity(http, "spec", {
        "title": "Postmortem (private draft) — checkout-api 2026-05-17",
        "content": POSTMORTEM_TEMPLATE,
        "spec_type": "plan",
    })
    print(f"  skill         trace-n-plus-one          : {skill_trace[:8]}")
    print(f"  skill         blast-radius-checker      : {skill_blast[:8]}")
    print(f"  skill         regression-test-coverage  : {skill_regr[:8]}")
    print(f"  agent         checkout-incident-responder: {agent_responder[:8]}")
    print(f"  spec  shared  Incident report           : {spec_incident[:8]}")
    print(f"  spec  shared  Fix plan                  : {spec_fix[:8]}")
    print(f"  spec  PRIVATE Postmortem draft          : {spec_postmortem[:8]}")

    # --- Build conversation locally -----------------------------------------
    ALICE_ID = "alice-demo-0001"
    BOB_ID = "bob-demo-0002"
    CONV_ID = str(uuid.uuid4())

    con = sqlite3.connect(str(db_path), timeout=30.0)
    con.execute("PRAGMA busy_timeout = 30000")

    # Look up local user for created_by
    row = con.execute("SELECT id FROM entities WHERE type='user' LIMIT 1").fetchone()
    LOCAL_USER = row[0] if row else "system"

    now = datetime.now(timezone.utc)
    base = now - timedelta(minutes=10)

    def ts(offset_sec: int):
        t = base + timedelta(seconds=offset_sec)
        return t.isoformat(), t.strftime("%Y-%m-%d %H:%M:%S.%f")

    # 1. Conversation row
    print("\n[build] writing conversation + 11 flow messages…")
    iso_now, sql_now = ts(660)  # newest update time
    conv = {
        "type": "conversation", "id": CONV_ID,
        "title": "checkout-api incident — diagnosis + ship",
        "message_count": 0, "message_ids": "[]",
        "participants": [
            {"user_id": ALICE_ID, "email": "alice@local.test", "name": "Alice"},
            {"user_id": BOB_ID,   "email": "bob@local.test",   "name": "Bob"},
        ],
        "message_status_visible": True,
        "context_entities": [{"type": "spec", "id": spec_incident}],
        "tags": [], "system": False, "remote": False, "orphan": False,
    }
    with_retry(
        con,
        "INSERT INTO entities (id, type, created_by, created_date, updated_by, updated_date, data) VALUES (?,?,?,?,?,?,?)",
        (CONV_ID, "conversation", LOCAL_USER, sql_now, LOCAL_USER, sql_now, json.dumps(conv)),
    )

    # 11-message script. Each entry: (sender, text, attachments, ctx_typeids, optional file_attachments)
    incident_ctx = {"type": "spec", "id": spec_incident}
    fix_ctx = {"type": "spec", "id": spec_fix}
    conv_ctx = {"type": "conversation", "id": CONV_ID}

    MSGS = [
        # 1 — Alice opens with incident spec + dashboard
        (ALICE_ID, "Alice",
         "Bob — checkout-api p99 went from 80ms → 4.2s at 14:03 UTC. Error rate is normal, just slow. v2.41 hit canary at 13:45. Full incident report attached + the Datadog board. Take a look?",
         [{"attachment_type": "type_id", "data": f"spec-{spec_incident}"},
          {"attachment_type": "url",     "data": "https://datadog.example.com/dash/checkout-latency?from=14:00&to=15:00&deploy=v2.41-canary"}],
         [incident_ctx], None),

        # 2 — Bob shares his on-call AGENT + asks for traces
        (BOB_ID, "Bob",
         "Got it. Spinning up my on-call responder agent — share it with you so you have it for next time too. Meanwhile pull 2-3 trace IDs with p99 > 3s in the last 10 min and drop them here.",
         [{"attachment_type": "type_id", "data": f"agent-{agent_responder}"}],
         [incident_ctx], None),

        # 3 — Alice posts traces + REPO + FILE log excerpt
        (ALICE_ID, "Alice",
         "Three traces, all on /checkout/finalize:\n  • tr_a1b2c3 — 4.2s, 8-item cart\n  • tr_c3d4e5 — 3.8s, 6-item cart\n  • tr_e5f6a7 — 4.6s, 11-item cart\nLatency scales with cart size — pattern-y. Repo + raw log excerpt for tr_a1b2c3 attached.",
         [{"attachment_type": "repo", "data": str(Path(__file__).resolve().parents[1])},
          {"attachment_type": "file", "data": "data/trace_excerpt.log"}],
         [incident_ctx],
         [("trace_excerpt.log", TRACE_EXCERPT_LOG)]),

        # 4 — Bob shares blast-radius skill + Approve & Execute
        (BOB_ID, "Bob",
         "Before we trace queries, let me quantify the user impact so we know whether to keep digging or roll back now. Sharing my blast-radius skill — Approve & Run, it'll spit a one-line recommendation.",
         [{"attachment_type": "type_id", "data": f"skill-{skill_blast}"},
          {"attachment_type": "prompt",  "data": "Run blast-radius-checker on the Datadog window 2026-05-17T14:00Z–14:10Z for service=checkout-api. Compute lost-request-seconds, affected user count at 10% canary, and emit a one-line recommendation."}],
         [incident_ctx], None),

        # 5 — Alice runs it, ASCII graph file, PRIVATE: Task + AgenticProcess
        (ALICE_ID, "Alice",
         "Ran it:\n  • Lost req-seconds: ~80 sec/req at p99 × 6.4k req/s canary = ~512 user-seconds/min\n  • Affected users (10% canary): ~640 active sessions / min\n  • Recommendation: **ROLL BACK CANARY NOW**, diagnose offline\nLooping the canary back to v2.40. Latency snapshot attached.",
         [{"attachment_type": "file", "data": "data/p99_latency_graph.txt"}],
         [incident_ctx],
         [("p99_latency_graph.txt", P99_GRAPH_TXT)]),

        # 6 — Bob shares trace-n-plus-one + Approve & Execute
        (BOB_ID, "Bob",
         "Good call. Now that the bleeding's stopped, let's identify the actual culprit. Latency-scales-with-N is the N+1 fingerprint. Sharing trace-n-plus-one — point it at those three traces.",
         [{"attachment_type": "type_id", "data": f"skill-{skill_trace}"},
          {"attachment_type": "prompt",  "data": "Run trace-n-plus-one against traces tr_a1b2c3, tr_c3d4e5, tr_e5f6a7 in the checkout-api log window 2026-05-17T14:00Z–14:10Z. Surface top-3 N+1 candidates with file:line refs, the suggested batched alternative, and deploy-header correlation."}],
         [incident_ctx], None),

        # 7 — Alice posts the skill output
        (ALICE_ID, "Alice",
         "Output:\n  TOP-1  cart_service.py:142  enrich_cart_lines()\n         ↳ 8 sequential queries per cart, ~500ms each\n         ↳ batched alt exists: product_repo.batched_lookup() (product_repo.py:88)\n  TOP-2  cart_service.py:201  recalc_totals()      — N=1, not the culprit\n  TOP-3  pricing_service.py:55 apply_promos()      — N=2 best case, fine\n100% of slow traces carry x-deploy-id=v2.41-canary. Hypothesis confirmed.",
         [], [incident_ctx], None),

        # 8 — Alice attaches the fix plan SPEC
        (ALICE_ID, "Alice",
         "Drafted the fix — swap to batched_lookup(), add property-based regression so this can't ship again. Plan attached.",
         [{"attachment_type": "type_id", "data": f"spec-{spec_fix}"}],
         [incident_ctx, fix_ctx], None),

        # 9 — Bob shares regression-test-coverage skill
        (BOB_ID, "Bob",
         "Plan LGTM. One add: regression should assert ≤2 DB calls for ANY N, not just N=8. Sharing the test-gen skill we used on the inventory bug last sprint — point it at cart_service.py:142.",
         [{"attachment_type": "type_id", "data": f"skill-{skill_regr}"}],
         [incident_ctx, fix_ctx], None),

        # 10 — Alice posts PR + FILE summary
        (ALICE_ID, "Alice",
         "Done. 4 property tests covering N ∈ {1, 8, 32, 512}. Canary already rolled back, p99 settled at 90ms. PR up, summary attached.",
         [{"attachment_type": "url",  "data": "https://github.com/flowpad/checkout-api/pull/4218"},
          {"attachment_type": "file", "data": "data/PR_changes_summary.md"}],
         [incident_ctx, fix_ctx],
         [("PR_changes_summary.md", PR_SUMMARY_MD)]),

        # 11 — Bob ships
        (BOB_ID, "Bob",
         "Reviewed — ship it. Nice catch keeping v2.41 on canary instead of rolling 100% this morning, that's the only reason this stayed SEV-2. Link this conversation in the postmortem doc.",
         [], [incident_ctx, fix_ctx], None),
    ]

    fm_ids: list[str] = []
    pointers: list[dict] = []
    for i, (sender_id, sender_name, text, attachments, ctx_extra, file_atts) in enumerate(MSGS):
        fm_id = str(uuid.uuid4())
        fm_iso, fm_sql = ts(i * 60)
        fm_data = {
            "type": "flow_message", "id": fm_id,
            "text": text,
            "instruction": None,
            "attachment": attachments,
            "sender_id": sender_id, "sender_name": sender_name,
            "receiver_address": None, "receiver_address_type": None,
            "conversation_id": CONV_ID,
            "is_read": True, "is_archived": False,
            "delivery_status": "received",
            "delivered_at": fm_iso, "received_at": fm_iso,
            "is_draft": False, "kind": "user",
            "context_entities": [*ctx_extra, conv_ctx],
            "tags": [], "system": False, "remote": False, "orphan": False,
        }
        with_retry(
            con,
            "INSERT INTO entities (id, type, created_by, created_date, updated_by, updated_date, data) VALUES (?,?,?,?,?,?,?)",
            (fm_id, "flow_message", LOCAL_USER, fm_sql, LOCAL_USER, fm_sql, json.dumps(fm_data)),
        )
        fm_ids.append(fm_id)
        pointers.append({"typeid": f"flow_message-{fm_id}", "ts": fm_iso})

        for filename, content in (file_atts or []):
            write_file_attachment(fm_id, filename, content)

    # Patch message_ids
    conv["message_ids"] = json.dumps(pointers)
    conv["message_count"] = len(pointers)
    with_retry(
        con,
        "UPDATE entities SET data=? WHERE type='conversation' AND id=?",
        (json.dumps(conv), CONV_ID),
    )

    # conversation.jsonl on disk
    d = RECORDS_ROOT / "conversation" / f"conversation-@{CONV_ID}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "conversation.jsonl").write_text("\n".join(json.dumps(p) for p in pointers) + "\n")

    # --- Private context: Tasks + AgenticProcess tied to specific FMs -----
    # Per usePrivateContext.ts: filter is `entity.context_entities` contains
    # the FlowMessage TypeId. So we POST/insert these with context_entities
    # carrying flow_message-<id>.

    # Task on msg #5 (Alice's blast-radius result)
    msg5_fm_typeid = f"flow_message-{fm_ids[4]}"
    rollback_task_id = post_entity(http, "task", {
        "title": "Roll back canary to v2.40",
        "description": "Hotfix v2.41 → v2.40 on the canary. Watch p99 settle.",
        "status": "done",
        "context_entities": [msg5_fm_typeid],
    })

    # AgenticProcess on msg #5 — represents the blast-radius skill execution.
    # Use direct insert: the AgenticProcess REST endpoint is finicky.
    proc_id = str(uuid.uuid4())
    proc_iso, proc_sql = ts(5 * 60 - 30)
    proc_data = {
        "type": "agentic_process", "id": proc_id,
        "title": "blast-radius-checker run (Alice)",
        "status": "completed",
        "context_entities": [msg5_fm_typeid, conv_ctx],
        "tags": [], "system": False, "remote": False, "orphan": False,
    }
    with_retry(
        con,
        "INSERT INTO entities (id, type, created_by, created_date, updated_by, updated_date, data) VALUES (?,?,?,?,?,?,?)",
        (proc_id, "agentic_process", LOCAL_USER, proc_sql, LOCAL_USER, proc_sql, json.dumps(proc_data)),
    )

    # Task on msg #10 (Alice's PR up)
    msg10_fm_typeid = f"flow_message-{fm_ids[9]}"
    canary_watch_task_id = post_entity(http, "task", {
        "title": "Watch canary p99 for 30 min after re-deploy",
        "description": "Roll patched build to 10% canary; watch p99 dashboard; promote to 100% if held <120ms.",
        "status": "in_progress",
        "context_entities": [msg10_fm_typeid],
    })

    # ALSO: attach the private Postmortem spec to msg #11 via context_entities
    # so it shows in shared context only on Bob's "link in postmortem" message
    # — but make it visible only locally by not putting it on the conversation.
    # Already done above by NOT adding spec_postmortem to conv.context_entities.

    con.close()
    print(f"  ✓ {len(MSGS)} flow_message rows + 2 Tasks + 1 AgenticProcess")
    print(f"  ✓ conversation.message_count = {conv['message_count']}")

    # Force-bust the server cache via a PUT (the conv we just inserted directly
    # to SQLite may have been cached on first GET; PUT triggers re-save which
    # invalidates the entity cache).
    http.put(f"{LOCAL_API}/graph/conversation/{CONV_ID}",
             json={"title": conv["title"]})

    print(f"\n✓ Demo conversation seeded.")
    print(f"  id     : {CONV_ID}")
    print(f"  UI URL : http://localhost:4098/dock/conversation/{CONV_ID}")
    print(f"\n  Attached assets:")
    print(f"    SHARED  spec  : {spec_incident[:8]}  Incident report")
    print(f"    SHARED  spec  : {spec_fix[:8]}  Fix plan")
    print(f"    SHARED  skill : {skill_blast[:8]}  blast-radius-checker")
    print(f"    SHARED  skill : {skill_trace[:8]}  trace-n-plus-one")
    print(f"    SHARED  skill : {skill_regr[:8]}  regression-test-coverage")
    print(f"    SHARED  agent : {agent_responder[:8]}  checkout-incident-responder")
    print(f"    PRIVATE spec  : {spec_postmortem[:8]}  Postmortem draft (Alice only — not in conv.context)")
    print(f"    PRIVATE task  : {rollback_task_id[:8]}  Roll back canary  (msg #5)")
    print(f"    PRIVATE task  : {canary_watch_task_id[:8]}  Watch canary p99  (msg #10)")
    print(f"    PRIVATE proc  : {proc_id[:8]}  blast-radius run  (msg #5)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"\nDEMO FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
