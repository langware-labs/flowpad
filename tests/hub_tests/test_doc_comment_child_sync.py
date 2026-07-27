"""Generic entity-child live sync across two real instances — comments as vehicle.

Matrix: {create, update, delete} × {A→B, B→A}, asserting a child comment syncs both
ways between two cloud-logged-in backends via the hub, plus a doc-binding check.

A comment is the concrete case of the GENERIC ``is_child`` sync mechanism:
  - create auto-shares server-side (``handle_create_entity`` → ``create_child``),
  - update reflects on save (``Hub-Reflect``),
  - delete auto-propagates server-side (``handle_delete_by_id`` removes the hub
    ``is_child`` so the hub fans ``child_deleted``), with catch-up reconciliation
    (``_reconcile_deleted_children``) pruning a non-watching peer.
Nothing here is comment-specific — the same path carries any ``shared_child`` type.

The six CRUD cells use the CONVERSATION as the comment's parent: both peers already
hold the conversation, so no markdown materialization (the FS ``discover`` walks
``default_roots`` — every project + worktree — and is multi-second) is needed. One
extra ``doc_binding`` cell covers the markdown-anchored case (the comment carries the
doc as ``parent_type_id`` — "doc wins over the conversation envelope"): alice authors
it under a doc she owns and bob receives it, so bob still needs no local doc.

Topology: two real backends (instance_ctl ``dev-1`` = alice, ``dev-2`` = bob) + the
local hub. Each backend owns its hub connection / watches / bridge — the faithful way
to exercise the watch+``FlowpadService`` child-sync model. Assertions go through the
receiver's REST after a catch-up sync, reading the comment body via ``?expand=blobs``
(``raw_content`` is a blob). The delete cells first confirm the comment is present on
BOTH sides (validate sent + present) before deleting.

Driven SYNCHRONOUSLY (httpx.Client) — the flow is sequential and a sync client avoids
the pytest-asyncio per-await overhead.

Scenarios (canonical specs + cross-layer key):
  Scenario: doc_comment_create_sync
  Source: ui/tests/manual_regression/collaboration/doc_comment_create_sync.md
  ScenarioId: 987c8038-f50c-464d-b817-01985ac72d5c
  Scenario: doc_comment_update_sync
  Source: ui/tests/manual_regression/collaboration/doc_comment_update_sync.md
  ScenarioId: a43f4285-07ed-4f06-b299-071da5081e5e
  Scenario: doc_comment_delete_sync
  Source: ui/tests/manual_regression/collaboration/doc_comment_delete_sync.md
  ScenarioId: 7dbcead1-46c8-434c-96d2-eac23050729f

Caps (CLAUDE.md, non-negotiable — never raise): pytest.ini --timeout=30. Per-cell
convergence is sub-second; CONVERGE is a 10s safety deadline (well above normal — not
a slow-path mask). Requires the two instances up; skips cleanly otherwise.
"""
from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import httpx
import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
ALICE_INSTANCE = os.environ.get("ALICE_INSTANCE", "dev-1")
BOB_INSTANCE = os.environ.get("BOB_INSTANCE", "dev-2")
# Per-assertion convergence deadline. Normal is sub-second; a safety cap, NOT a
# slow-path mask — do not raise (CLAUDE.md). The 30s pytest cap bounds the run.
CONVERGE = 10.0


def _instance_backend(name: str) -> str | None:
    """Backend base URL for an instance_ctl instance, from ``.env.<name>.local``."""
    env = REPO_ROOT / f".env.{name}.local"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith("LOCAL_SERVER_PORT="):
            port = line.split("=", 1)[1].strip().strip('"').strip("'")
            return f"http://localhost:{port}"
    return None


def _reachable_logged_in(base: str) -> bool:
    try:
        if httpx.get(f"{base}/api/v1/health/status", timeout=2.0).status_code // 100 != 2:
            return False
        data = (httpx.get(f"{base}/api/v1/cloud/status", timeout=3.0).json() or {}).get("data") or {}
        return (data.get("login") or {}).get("status") == "logged_in"
    except Exception:
        return False


@pytest.fixture(scope="module")
def two_backends(hub_base_url) -> dict:
    alice = os.environ.get("OSS_BE") or _instance_backend(ALICE_INSTANCE)
    bob = os.environ.get("APP_BE") or _instance_backend(BOB_INSTANCE)
    if not alice or not bob:
        pytest.skip(
            f"two instances required: `scripts/instance_ctl.sh launch {ALICE_INSTANCE}` "
            f"and `{BOB_INSTANCE}` (or set OSS_BE/APP_BE)"
        )
    if not _reachable_logged_in(alice) or not _reachable_logged_in(bob):
        pytest.skip("both backends must be up and cloud-logged-in")
    return {
        "alice": alice,
        "bob": bob,
        "hub": hub_base_url,
        "bob_pw": os.environ.get("BOB_PW", f"{BOB_INSTANCE}-pw-1234"),
    }


def _u(r: httpx.Response):
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and j.get("status") not in (None, "SUCCESS"):
        raise RuntimeError(f"{r.request.method} {r.request.url} -> {str(j)[:200]}")
    return j.get("data") if isinstance(j, dict) else j


def _sync(c, be, conv_id):
    try:
        c.post(f"{be}/api/v1/graph/conversation-message-sync", json={"conversation_id": conv_id})
    except Exception:
        pass


def _comment(c, be, cid):
    r = c.get(f"{be}/api/v1/graph/comment/{cid}?expand=blobs")
    if r.status_code != 200:
        return None
    d = r.json().get("data")
    return d if d and d.get("id") == cid else None


def _wait_text(c, be, conv_id, cid, text):
    end = time.monotonic() + CONVERGE
    while time.monotonic() < end:
        _sync(c, be, conv_id)
        d = _comment(c, be, cid)
        if d and d.get("raw_content") == text:
            return d
        time.sleep(0.3)
    return None


def _wait_absent(c, be, conv_id, cid):
    end = time.monotonic() + CONVERGE
    while time.monotonic() < end:
        _sync(c, be, conv_id)
        if _comment(c, be, cid) is None:
            return True
        time.sleep(0.3)
    return False


def _mk(c, be, parent_type, parent_id, text, line):
    return _u(c.post(
        f"{be}/api/v1/graph/{parent_type}/{parent_id}/comment",
        json={"raw_content": text, "data": {"line": line}},
    ))["id"]


def _scoped_ids(c, be, parent_type, parent_id):
    """Comments visible through the SCOPED list — the exact route the UI's
    role-walk query hits (``GET /graph/<parent>/<id>/comment``). Resolves through
    the local is_child edge, so this asserts the receiver kernel recreated it —
    a bare row copy (pre-fix behavior) returns [] here while the by-id GET passes."""
    r = c.get(f"{be}/api/v1/graph/{parent_type}/{parent_id}/comment?expand=blobs")
    if r.status_code != 200:
        return {}
    return {d["id"]: d for d in (r.json().get("data") or []) if isinstance(d, dict) and d.get("id")}


def _wait_scoped(c, be, conv_id, parent_type, parent_id, cid):
    end = time.monotonic() + CONVERGE
    while time.monotonic() < end:
        _sync(c, be, conv_id)
        d = _scoped_ids(c, be, parent_type, parent_id).get(cid)
        if d is not None:
            return d
        time.sleep(0.3)
    return None


def _build_shared(c, env, stamp):
    """Alice creates a markdown + conversation (markdown in shared_context, for the
    doc-binding cell), shares with bob; bob accepts. No bob-side ``discover``."""
    alice, bob, hub = env["alice"], env["bob"], env["hub"]
    bob_email = _u(c.get(f"{bob}/api/v1/cloud/status"))["login"]["user"]["email"]
    bd = c.post(f"{hub}/api/v1/login", json={"email": bob_email, "password": env["bob_pw"]}).json()["data"]
    bob_hdr = {"Authorization": f"Bearer {bd.get('api_key') or bd['token']}"}

    docs = os.path.expanduser("~/docs")
    os.makedirs(docs, exist_ok=True)
    md_path = os.path.join(docs, f"comment-sync-{stamp}.md")
    body = "# Shared doc\n\nLine 2\nLine 3\nLine 4\n"
    Path(md_path).write_text(body)
    md_id = _u(c.post(f"{alice}/api/v1/graph/markdown", json={"title": f"Doc {stamp}", "asset_ref": md_path}))["id"]
    Path(md_path).write_text(f"---\nid: {md_id}\n---\n\n{body}")
    md_ref = f"markdown-{md_id}"
    conv_obj = _u(c.post(f"{alice}/api/v1/graph/conversation", json={"title": f"Conv {stamp}", "shared_context_entities": [md_ref]}))
    conv_id = conv_obj["id"]
    # The full conv object MUST ride the share body so _link_context_to_conversation
    # links the doc → conversation (effective-remote → comments under it auto-share).
    _u(c.post(f"{alice}/api/v1/graph/conversation/{conv_id}/share", json={**conv_obj, "recipients": [bob_email]}))

    accepted = False
    for _ in range(40):
        pending = (c.get(f"{hub}/api/v1/graph/invitation/pending", headers=bob_hdr).json().get("data")) or []
        inv = [i for i in pending if conv_id in str(i.get("conversation") or "") and not i.get("accepted")]
        if inv:
            c.post(f"{bob}/api/v1/graph/invitation-accept", json={"invitation_id": inv[0]["id"]})
            accepted = True
            break
        time.sleep(0.3)
    assert accepted, "bob never received/accepted the conversation invitation"
    # One sync so bob materializes the conversation (so his catch-up pulls its children).
    _sync(c, bob, conv_id)
    return md_id, md_ref, conv_id, md_path


@pytest.fixture(scope="module")
def shared(two_backends):
    """Build the shared conversation ONCE for the module (~6s); each per-op test
    then runs only its two cells so no single test crowds the 30s cap."""
    stamp = uuid.uuid4().hex[:8]
    cleanup_path = Path(os.path.expanduser("~/docs")) / f"comment-sync-{stamp}.md"
    c = httpx.Client(timeout=15.0)
    try:
        md_id, md_ref, conv_id, md_path = _build_shared(c, two_backends, stamp)
        yield {**two_backends, "client": c, "md_id": md_id, "md_ref": md_ref, "conv_id": conv_id,
               "md_path": md_path, "stamp": stamp}
    finally:
        try:
            c.close()
        finally:
            cleanup_path.unlink(missing_ok=True)


def test_doc_comment_create_sync(shared):
    """A comment created by either peer reaches the other (doc_comment_create_sync)."""
    c, alice, bob = shared["client"], shared["alice"], shared["bob"]
    conv_id, stamp = shared["conv_id"], shared["stamp"]

    cid = _mk(c, alice, "conversation", conv_id, f"alice-create-{stamp}", 3)
    assert _wait_text(c, bob, conv_id, cid, f"alice-create-{stamp}"), "create A→B: bob never received alice's comment"
    # Receiver contract: the row must also be reachable through the UI's SCOPED
    # query (edge-backed), not just the by-id GET — the exact gap of the live bug.
    got = _wait_scoped(c, bob, conv_id, "conversation", conv_id, cid)
    assert got is not None, "create A→B: comment not visible through bob's scoped (edge-backed) query"
    assert got.get("raw_content") == f"alice-create-{stamp}", "create A→B: scoped query must carry the body"

    cid = _mk(c, bob, "conversation", conv_id, f"bob-create-{stamp}", 4)
    assert _wait_text(c, alice, conv_id, cid, f"bob-create-{stamp}"), "create B→A: alice never received bob's comment"
    got = _wait_scoped(c, alice, conv_id, "conversation", conv_id, cid)
    assert got is not None, "create B→A: comment not visible through alice's scoped (edge-backed) query"


def test_doc_comment_update_sync(shared):
    """Editing a comment's text syncs to the other peer (doc_comment_update_sync)."""
    c, alice, bob = shared["client"], shared["alice"], shared["bob"]
    conv_id = shared["conv_id"]

    cid = _mk(c, alice, "conversation", conv_id, "u1", 3)
    assert _wait_text(c, bob, conv_id, cid, "u1"), "update setup: bob must first see u1"
    c.put(f"{alice}/api/v1/graph/comment/{cid}", json={"raw_content": "edited-by-alice"}, headers={"Hub-Reflect": "true"})
    assert _wait_text(c, bob, conv_id, cid, "edited-by-alice"), "update A→B: edit did not reach bob"

    cid = _mk(c, bob, "conversation", conv_id, "u1", 4)
    assert _wait_text(c, alice, conv_id, cid, "u1"), "update setup: alice must first see u1"
    c.put(f"{bob}/api/v1/graph/comment/{cid}", json={"raw_content": "edited-by-bob"}, headers={"Hub-Reflect": "true"})
    assert _wait_text(c, alice, conv_id, cid, "edited-by-bob"), "update B→A: edit did not reach alice"


def test_doc_comment_delete_sync(shared):
    """Deleting a comment removes it for the other peer (doc_comment_delete_sync).

    Confirms the comment is present on BOTH sides before deleting (validate sent +
    present), then asserts it is gone for the deleter locally AND for the peer."""
    c, alice, bob = shared["client"], shared["alice"], shared["bob"]
    conv_id = shared["conv_id"]

    cid = _mk(c, alice, "conversation", conv_id, "to-delete-a", 3)
    assert _wait_text(c, alice, conv_id, cid, "to-delete-a"), "delete setup: present on alice (sender)"
    assert _wait_text(c, bob, conv_id, cid, "to-delete-a"), "delete setup: present on bob (peer)"
    c.request("DELETE", f"{alice}/api/v1/graph/comment/{cid}")  # server auto-propagates; no Hub-Reflect
    assert _comment(c, alice, cid) is None, "delete A→B: comment must be gone locally for the deleter"
    assert _wait_absent(c, bob, conv_id, cid), "delete A→B: comment must disappear for bob"

    cid = _mk(c, bob, "conversation", conv_id, "to-delete-b", 4)
    assert _wait_text(c, bob, conv_id, cid, "to-delete-b"), "delete setup: present on bob (sender)"
    assert _wait_text(c, alice, conv_id, cid, "to-delete-b"), "delete setup: present on alice (peer)"
    c.request("DELETE", f"{bob}/api/v1/graph/comment/{cid}")
    assert _comment(c, bob, cid) is None, "delete B→A: comment must be gone locally for the deleter"
    assert _wait_absent(c, alice, conv_id, cid), "delete B→A: comment must disappear for alice"


def test_doc_comment_doc_binding(shared):
    """A comment authored under the shared markdown carries the DOC as its
    parent_type_id on the receiver — "doc wins over the conversation envelope" —
    even though it rides the hub under the conversation (A→B; bob needs no local doc)."""
    c, alice, bob = shared["client"], shared["alice"], shared["bob"]
    conv_id, md_id, md_ref, stamp = shared["conv_id"], shared["md_id"], shared["md_ref"], shared["stamp"]

    cid = _mk(c, alice, "markdown", md_id, f"on-doc-{stamp}", 3)
    got = _wait_text(c, bob, conv_id, cid, f"on-doc-{stamp}")
    assert got is not None, "doc-binding: bob never received the doc comment"
    assert got.get("parent_type_id") == md_ref, "doc-binding: comment must bind to the doc, not the conversation envelope"
    # Sender-side gutter parity: alice authored via add_child, so her doc-scoped
    # (edge-backed) query — the exact route the review gutter hits — must see it.
    assert cid in _scoped_ids(c, alice, "markdown", md_id), "doc-binding: comment missing from alice's doc-scoped query"


def test_doc_comment_receiver_scope_visibility(shared):
    """The receiver's doc GUTTER sees a synced comment once the doc materializes
    locally — the full receiver contract: kernel edge recreation for children whose
    parent already exists, orphan REBIND for children that synced first, and blob
    transport (body present through the scoped route).

    Bob materializes the shared md AFTER alice's comment reached him (same entity id
    — the file carries its id in frontmatter, adopted on create), so the comment is
    a pre-existing orphan that only ``_rebind_orphan_children`` can link."""
    c, alice, bob = shared["client"], shared["alice"], shared["bob"]
    conv_id, md_id, md_path, stamp = shared["conv_id"], shared["md_id"], shared["md_path"], shared["stamp"]

    # 1) Alice comments on the doc; bob receives the ROW (his doc row may not exist yet).
    cid = _mk(c, alice, "markdown", md_id, f"gutter-{stamp}", 4)
    assert _wait_text(c, bob, conv_id, cid, f"gutter-{stamp}"), "receiver-scope: bob never received the doc comment row"

    # 2) Bob materializes the doc locally via the INDEXER (the real receiver path —
    #    install/index), which adopts the frontmatter capsule id → same entity id.
    idx = _u(c.post(
        f"{bob}/api/v1/graph/compute_node/@local/fs-records/index",
        params={"type": "markdown", "path": md_path},
    ))
    assert f"markdown-{md_id}" in (idx.get("typeids") or []), (
        f"receiver-scope: bob's index must adopt the sender's entity id, got {idx.get('typeids')}"
    )

    # 3) Next catch-up sync rebinds the orphan; the doc-scoped (edge-backed) query —
    #    exactly what the review gutter runs — must now surface it, body included.
    got = _wait_scoped(c, bob, conv_id, "markdown", md_id, cid)
    assert got is not None, "receiver-scope: comment not visible in bob's doc gutter query after rebind"
    assert got.get("raw_content") == f"gutter-{stamp}", "receiver-scope: gutter query must carry the comment body"
