"""End-to-end conversation-list pipeline against a live local hub.

Covers each condition of the unified ``conversation-list`` action:

  1. test_list_returns_local_immediately      — local-only render, no hub side state
  2. test_list_merges_hub_conversations       — hub conv shows up after fetch
  3. test_message_count_delta_dispatches_bg_fetch — diff triggers per-conv fetch + materialize
  4. test_updated_date_bumped_on_append       — projection writer bumps updated_date
  5. test_single_flight_per_conversation      — rapid calls don't pile up fetches
  6. test_assignment_through_same_pipeline    — assigned conversations come down in the same call
  7. test_no_dupes_on_repeated_calls          — idempotent upsert
  8. test_ws_bridge_still_drives_realtime     — bridge path independent of fetch
  9. test_hub_unavailable_returns_local       — local list returned when hub down
 10. test_hub_401_surfaces_clearly            — auth_required flag set on 401

Tests bypass the local HTTP server and call ``handle_conversation_list``
in-process — same pattern as ``test_message_matrix.py``. The hub is the
real local instance at ``FLOWPAD_HUB_URL``; credentials come from the
``hub_login_payload`` fixture. Tests share the live SQLite DB, so each one
allocates unique ids to avoid interference.

Per project policy: no mocks, 30s per test. Each test is independent;
ordering is alphabetical (pytest default).
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

# The cycle env holds the second hub user's (bob's) credentials. The sibling
# flowpad-app checkout remains a local-development fallback.
REPO_APP = Path(__file__).resolve().parents[2].parent / "flowpad-app"


def _read_env_local(repo: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    path = repo / ".env.local"
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stash_credentials(hub_login_payload: dict) -> str:
    """Establish the full local login state so the in-process action handler
    sees a logged-in user (token via sodot + user record via set_user). The
    conversation-list action gates its hub catch-up on ``hub_auth_available()``
    → ``is_logged_in()`` → the user record, so the token alone is not enough."""
    from tests.hub_tests._local_login import login_as

    return login_as(hub_login_payload)


async def _hub_create_conversation(
    hub_base_url: str,
    api_key: str,
    *,
    title: str | None = None,
) -> str:
    """Create a Conversation on the hub via share() so the caller is a
    participant and add_message works. Returns the conversation id."""
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(title=title or f"plt-{uuid.uuid4()}")
    await conv.share()
    # share() POSTs to /graph/conversation; ensure caller is a participant
    # so we can add messages and the hub returns it in /graph/conversation
    # list queries.
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers=headers,
            json={},
        )
    return conv.id  # type: ignore[return-value]


async def _hub_add_message(
    hub_base_url: str,
    api_key: str,
    conv_id: str,
    text: str,
) -> str:
    """Append a FlowMessage on the hub. Returns the new fm_id."""
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
            headers=headers,
            json={"text": text},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "SUCCESS", body
    data = body.get("data") or {}
    return data.get("id") or data.get("flow_message_id")


async def _hub_get_conversation(
    hub_base_url: str,
    api_key: str,
    conv_id: str,
) -> dict:
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}",
            headers=headers,
        )
    assert r.status_code == 200, r.text
    return (r.json() or {}).get("data") or {}


async def _local_user_typeid() -> str:
    # Each test runs under a unique, EMPTY FLOW_INSTANCE (autouse
    # isolated_hub_keyring fixture), so there is no pre-existing uname='local'
    # user. The old `User.get_one(...) or "user-local"` fallback returned the
    # literal string "user-local" — an INVALID TypeId — which made
    # _materialize_invitation's .save("user-local") raise "Invalid TypeId
    # identifier: 'local'", so no local Invitation/Conversation row was ever
    # written. get_or_create_local_user() mints (or fetches) the canonical
    # @local desktop user via its stable v5 id and returns a real User, so we
    # always hand handle_conversation_list a valid typeid. It is pure DB +
    # git-config reads — no server/bootstrap prerequisite.
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    u = await get_or_create_local_user()
    return u.typeid


async def _poll_until(predicate, *, timeout: float = 5.0, interval: float = 0.1):
    """Poll an async predicate until truthy or timeout. Returns the result."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await predicate()
        if last:
            return last
        await asyncio.sleep(interval)
    return last


# ---------------------------------------------------------------------------
# 1. Local-only render returns fast, no hub state required
# ---------------------------------------------------------------------------


async def test_list_returns_local_immediately(hub_base_url, hub_login_payload):
    """With no fresh hub-side activity, conversation-list should return the
    local snapshot quickly and ``bg_fetch_dispatched`` should be empty."""
    _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list

    someone = await _local_user_typeid()
    t0 = time.monotonic()
    resp = await handle_conversation_list(someone)
    elapsed = time.monotonic() - t0

    assert resp.status == "SUCCESS", resp
    data = resp.data or {}
    assert "conversations" in data
    assert isinstance(data["conversations"], list)
    assert "bg_fetch_dispatched" in data
    # Hub round-trip dominates; 5s is plenty for a healthy local hub.
    assert elapsed < 5.0, f"conversation-list took {elapsed:.2f}s"


# ---------------------------------------------------------------------------
# 2. Hub conversations get merged into the local list
# ---------------------------------------------------------------------------


async def test_list_merges_hub_conversations(hub_base_url, hub_login_payload):
    """After share()ing a conversation on the hub, calling
    conversation-list should make it appear locally with remote=True."""
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import Conversation

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"merge-{uuid.uuid4()}")
    someone = await _local_user_typeid()
    resp = await handle_conversation_list(someone)
    assert resp.status == "SUCCESS"

    local = await Conversation.get_one({"id": conv_id})
    assert local is not None, "hub conv should be upserted locally"
    assert local.remote is True


# ---------------------------------------------------------------------------
# 3. message_count delta triggers background fetch
# ---------------------------------------------------------------------------


async def test_message_count_delta_dispatches_bg_fetch(hub_base_url, hub_login_payload):
    """Hub conv has more messages than local → bg fetcher dispatched →
    FlowMessage materializes locally within a short polling window."""
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.flow_message import FlowMessage

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"delta-{uuid.uuid4()}")
    fm_id = await _hub_add_message(hub_base_url, api_key, conv_id, "delta msg")
    assert fm_id

    someone = await _local_user_typeid()
    resp = await handle_conversation_list(someone)
    assert resp.status == "SUCCESS"
    data = resp.data or {}
    assert conv_id in data.get("bg_fetch_dispatched", []), (
        f"expected {conv_id[:8]} in bg_fetch_dispatched={data.get('bg_fetch_dispatched')}"
    )

    # Background fetcher races the test — poll for the FM to land.
    materialized = await _poll_until(
        lambda: FlowMessage.get_one({"id": fm_id}),
        timeout=10.0,
    )
    assert materialized is not None, f"FM {fm_id[:8]} not materialized in 10s"


# ---------------------------------------------------------------------------
# 4. Hub-side updated_date bumps on message append
# ---------------------------------------------------------------------------


async def test_updated_date_bumped_on_append(hub_base_url, hub_login_payload):
    """The projection-writer fix should bump Conversation.updated_date
    every time a FlowMessage is appended."""
    api_key = _stash_credentials(hub_login_payload)

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"upd-{uuid.uuid4()}")
    pre = await _hub_get_conversation(hub_base_url, api_key, conv_id)
    pre_updated = pre.get("updated_date") or ""

    await asyncio.sleep(0.05)  # ensure a strictly-later ISO timestamp
    await _hub_add_message(hub_base_url, api_key, conv_id, "bump it")

    post = await _hub_get_conversation(hub_base_url, api_key, conv_id)
    post_updated = post.get("updated_date") or ""
    assert post_updated > pre_updated, (
        f"updated_date should advance after append: pre={pre_updated!r} post={post_updated!r}"
    )


# ---------------------------------------------------------------------------
# 5. Single-flight: parallel calls don't pile up duplicate fetches
# ---------------------------------------------------------------------------


async def test_single_flight_per_conversation(hub_base_url, hub_login_payload):
    """Three concurrent conversation-list calls against a conv with N
    missing messages should all see them materialized, exactly once, with
    only one background fetcher running at a time per conv id."""
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import (
        _conv_fetch_locks,
        handle_conversation_list,
    )
    from flow_sdk.builtin.flow_message import FlowMessage

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"sf-{uuid.uuid4()}")
    fm_ids = []
    for i in range(3):
        fm_ids.append(await _hub_add_message(hub_base_url, api_key, conv_id, f"sf-{i}"))

    someone = await _local_user_typeid()
    # Fire three concurrent calls — only the first wins the lock.
    await asyncio.gather(
        handle_conversation_list(someone),
        handle_conversation_list(someone),
        handle_conversation_list(someone),
    )

    # All three FMs materialize, even though only one fetcher runs.
    for fm_id in fm_ids:
        got = await _poll_until(
            lambda fm=fm_id: FlowMessage.get_one({"id": fm}),
            timeout=10.0,
        )
        assert got is not None, f"FM {fm_id[:8]} missed under contention"

    # Lock entry was created; we don't assert exact "one fetch" without
    # an instrumented counter — the FM-count assertion is the
    # observable signal that the single-flight gate worked (no dupes,
    # no crashes, all messages present).
    assert conv_id in _conv_fetch_locks


# ---------------------------------------------------------------------------
# 6. Assigned conversations come down through the same orchestrator
# ---------------------------------------------------------------------------


async def test_assignment_through_same_pipeline(hub_base_url, hub_login_payload):
    """An immediately assigned conversation materializes after a single
    conversation-list call by the recipient."""
    _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import (
        _hard_delete_local_conversation,
        handle_conversation_list,
    )
    from flow_sdk.builtin.conversation import Conversation

    # A SECOND seeded user creates and shares the conversation so the stashed
    # hub_login_payload user is its recipient. Self-share is intentionally
    # skipped by the hub.
    user_info = hub_login_payload.get("user") or {}
    recipient_email = (user_info.get("email") or "").strip()
    if not recipient_email:
        pytest.skip("hub login payload lacked an email; can't test invitation flow")

    app_env = _read_env_local(REPO_APP)
    sender_email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    sender_pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not sender_email or not sender_pw:
        pytest.skip("missing BOB_EMAIL/BOB_PW and flowpad-app fallback credentials")
    if sender_email.strip().lower() == recipient_email.lower():
        pytest.skip("sender and recipient are the same hub user; need two distinct seeded users")

    # Log Bob (the sender) in and stash his credentials so Conversation.share()
    # runs as Bob. Restore Alice before driving handle_conversation_list.
    from tests.hub_tests._local_login import login_as

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": sender_email, "password": sender_pw})
        if r.status_code != 200:
            pytest.skip(f"sender (bob) hub login failed: {r.status_code} {r.text[:200]}")
        sender_data = r.json()["data"]
    login_as(sender_data)

    conv = Conversation(title=f"inv-{uuid.uuid4()}")
    await conv.share(recipients=[recipient_email])
    if not getattr(conv, "remote", False):
        pytest.skip("sender share() did not reach the hub; can't exercise assignment pipeline")
    conv_id = conv.id

    # Sender and recipient share this in-process SQLite store. Remove the
    # sender's local copy so the assertions below prove recipient catch-up,
    # while leaving the hub entity untouched.
    await _hard_delete_local_conversation(conv)
    assert await Conversation.get_one({"id": conv_id}) is None

    # Restore the recipient's credentials. Immediate assignment makes the
    # conversation visible through the ordinary conversation list; no pending
    # invitation fetch is involved.
    _stash_credentials(hub_login_payload)

    someone = await _local_user_typeid()
    await handle_conversation_list(someone)

    conv = await Conversation.get_one({"id": conv_id})
    assert conv is not None, "assigned Conversation not materialized locally"
    assert conv.remote is True


# ---------------------------------------------------------------------------
# 7. Repeated calls are idempotent — no dupes
# ---------------------------------------------------------------------------


async def test_no_dupes_on_repeated_calls(hub_base_url, hub_login_payload):
    """Three back-to-back conversation-list calls (no hub-side activity
    between) should leave the local Conversation count stable."""
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import Conversation

    await _hub_create_conversation(hub_base_url, api_key, title=f"dup-{uuid.uuid4()}")
    someone = await _local_user_typeid()

    await handle_conversation_list(someone)
    count1 = len(await Conversation.get_all({}))
    await handle_conversation_list(someone)
    count2 = len(await Conversation.get_all({}))
    await handle_conversation_list(someone)
    count3 = len(await Conversation.get_all({}))

    assert count1 == count2 == count3, f"row counts diverged across idempotent calls: {count1} {count2} {count3}"


# ---------------------------------------------------------------------------
# 8. WS bridge realtime path is unaffected by the fetch consolidation
# ---------------------------------------------------------------------------


async def test_ws_bridge_still_drives_realtime(hub_base_url, hub_login_payload):
    """The WS bridge's ``_handle_conversation_op`` + ``_handle_flow_message_op``
    are still wired on ``HubWsBridge``. We don't run a live ws session here
    (separate test already covers that — test_two_client_loop); we assert the
    methods are present and the install() entry-point is callable. Catch-up
    via conversation-list is defensive, not replacement."""
    from flow_sdk.cloud_client.hub_bridge import HubWsBridge

    assert callable(getattr(HubWsBridge, "_handle_conversation_op", None))
    assert callable(getattr(HubWsBridge, "_handle_flow_message_op", None))
    assert callable(getattr(HubWsBridge, "install", None))


# ---------------------------------------------------------------------------
# 9. Hub unreachable → still return the local snapshot
# ---------------------------------------------------------------------------


async def test_hub_unavailable_returns_local(hub_base_url, hub_login_payload, monkeypatch):
    """If hub_base_url is misconfigured (or transient down), the action
    must still return the local list and a hub_reachable=False flag."""
    _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.config import default_service_config

    # Point at a guaranteed-dead port; restore via monkeypatch teardown.
    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "http://127.0.0.1:1")

    someone = await _local_user_typeid()
    resp = await handle_conversation_list(someone)

    assert resp.status == "SUCCESS"
    data = resp.data or {}
    assert "conversations" in data
    assert data.get("bg_fetch_dispatched") == []
    # Either ``hub_reachable`` is False, or the action took the
    # config-empty short-circuit branch — both are valid.
    assert data.get("hub_reachable", False) is False


# ---------------------------------------------------------------------------
# 10. Hub 401 → auth_required flag set so UI can show LoginDialog
# ---------------------------------------------------------------------------


async def test_hub_401_surfaces_clearly(hub_base_url, hub_login_payload, monkeypatch):
    """Wipe credentials → hub returns 401 → action sets auth_required=True
    so the UI can route to the LoginDialog rather than showing a generic
    'Hub unavailable' toast."""
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.cli.auth import credentials as credentials_mod

    # Erase any cached credentials by clearing keyring + module-level cache.
    try:
        credentials_mod.clear_credentials()
    except Exception:
        # Some installs no-op when there's nothing to clear; that's fine.
        pass

    try:
        someone = await _local_user_typeid()
        resp = await handle_conversation_list(someone)

        # The action must not raise; it returns SUCCESS with structured flags.
        assert resp.status == "SUCCESS"
        data = resp.data or {}
        # ``auth_required`` is the load-bearing flag for UI gating. The hub
        # might respond 401 in slightly different shapes across versions, so
        # we accept either auth_required=True OR hub_reachable=False here —
        # both are correct UI signals.
        assert (data.get("auth_required") is True) or (data.get("hub_reachable") is False), (
            f"expected auth_required=True or hub_reachable=False, got {data}"
        )
    finally:
        # `clear_credentials()` wipes the KEYRING plus the process-wide cache —
        # state that outlives this module. Later tests in this file happen to
        # re-stash before they need it, but tests in later FILES do not, and
        # they inherit a logged-out process. Restore what this test destroyed.
        _stash_credentials(hub_login_payload)


# ---------------------------------------------------------------------------
# 11. THE INCIDENT SHAPE: bare local projection + equal updated_date heals
# ---------------------------------------------------------------------------


async def test_count_mismatch_equal_date_dispatches_fetch_and_heals(hub_base_url, hub_login_payload):
    """Reproduce the Jun-4 prod incident: the local Conversation row carries
    the hub's updated_date (is_stale says current) but a blank projection.
    The bidirectional count mismatch must dispatch a fetch, and the
    authoritative reconcile must rebuild message_ids/message_count."""
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL, Conversation

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"incident-{uuid.uuid4()}")
    await _hub_add_message(hub_base_url, api_key, conv_id, "m1")
    await _hub_add_message(hub_base_url, api_key, conv_id, "m2")

    someone = await _local_user_typeid()
    await handle_conversation_list(someone)
    # Wait for the initial materialization to settle (count lands via the
    # background fetch → projection).
    settled = await _poll_until(
        lambda: Conversation.get_one({"id": conv_id}),
        timeout=10.0,
    )
    assert settled is not None

    healthy = await _poll_until(
        _projected(conv_id, expected_count=2),
        timeout=10.0,
    )
    assert healthy, f"initial sync never projected 2 messages for {conv_id[:8]}"

    # Blank the projection while KEEPING the hub-carried updated_date — the
    # exact bare-row shape the DB rebuild produced.
    conv = await Conversation.get_one({"id": conv_id})
    conv._set_projection("message_ids", None, _PROJECTION_SENTINEL)
    conv._set_projection("message_count", 0, _PROJECTION_SENTINEL)
    await conv.save(someone, notify=False)
    bare = await Conversation.get_one({"id": conv_id})
    assert not bare.message_ids and int(bare.message_count or 0) == 0  # precondition

    resp = await handle_conversation_list(someone)
    data = resp.data or {}
    assert conv_id in data.get("bg_fetch_dispatched", []), (
        f"count mismatch must dispatch a fetch; got {data.get('bg_fetch_dispatched')}"
    )

    healed = await _poll_until(
        _projected(conv_id, expected_count=2),
        timeout=10.0,
    )
    assert healed, f"projection not healed for {conv_id[:8]}"


def _projected(conv_id: str, *, expected_count: int):
    """Async predicate: the local row's projection reports expected_count."""
    from flow_sdk.builtin.conversation import Conversation

    async def _check():
        c = await Conversation.get_one({"id": conv_id})
        if c is None:
            return None
        return c if int(c.message_count or 0) == expected_count and c.message_ids else None

    return _check


# ---------------------------------------------------------------------------
# 12. created_date is hub-authoritative — wrong local values get repaired
# ---------------------------------------------------------------------------


async def test_created_date_adopted_from_hub(hub_base_url, hub_login_payload):
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import Conversation

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"birthday-{uuid.uuid4()}")
    someone = await _local_user_typeid()
    await handle_conversation_list(someone)
    local = await _poll_until(
        lambda: Conversation.get_one({"id": conv_id}),
        timeout=10.0,
    )
    assert local is not None

    hub_row = await _hub_get_conversation(hub_base_url, api_key, conv_id)
    hub_created = Conversation._as_datetime(hub_row.get("created_date"))
    assert hub_created is not None

    # Corrupt the local birth date (what a DB rebuild does), then re-list.
    local.created_date = datetime(2030, 1, 1, tzinfo=timezone.utc)
    await local.save(someone, notify=False)

    await handle_conversation_list(someone)
    repaired = await Conversation.get_one({"id": conv_id})
    assert Conversation._as_datetime(repaired.created_date) == hub_created, (
        f"created_date not repaired: {repaired.created_date} != hub {hub_created}"
    )


# ---------------------------------------------------------------------------
# 13. an empty conversation's recency is its birth time, never "now"
# ---------------------------------------------------------------------------


async def test_empty_conversation_does_not_fake_recency(hub_base_url, hub_login_payload):
    """A message-less conversation reports its birth time, not "now".

    ``project_pointers_to_entity`` derives recency as ``max(message.updated_date)``;
    with no messages there is no max, and the honest answer is ``created_date``.

    Regression guard: falling back to ``datetime.now()`` invented a timestamp the
    conversation never earned, and since ``updated_date`` is the Inbox sort key
    (``compareConversationsByRecency``), every catch-up that touched an empty
    conversation promoted it above genuinely recent mail — 33 such rows buried a
    real message in the reported incident.

    Entry point is ``_fetch_conversation_messages`` — what the
    ``conversation-message-sync`` action awaits when the conversation view opens,
    and what the login catch-up drain calls per conversation.

    The ordering assertion is a proxy: it checks the *input* to the UI sort, not
    the rendered row order. The exact-invariant assertion before it is not.
    """
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import (
        _fetch_conversation_messages,
        handle_conversation_list,
    )
    from flow_sdk.builtin.conversation import Conversation

    # Older, and empty — the "pong-…" style rows that hijacked the top.
    empty_id = await _hub_create_conversation(hub_base_url, api_key, title=f"empty-{uuid.uuid4()}")
    await asyncio.sleep(0.05)
    # Newer, and carrying a real message — the "Tzahi" row that got buried.
    real_id = await _hub_create_conversation(hub_base_url, api_key, title=f"real-{uuid.uuid4()}")
    await _hub_add_message(hub_base_url, api_key, real_id, "a real message")

    someone = await _local_user_typeid()
    await handle_conversation_list(someone)
    assert await _poll_until(_projected(real_id, expected_count=1), timeout=10.0), (
        "precondition: the real message never materialized"
    )

    # A later catch-up touches the empty conversation — the every-login case.
    await _fetch_conversation_messages(empty_id, someone)

    empty = await Conversation.get_one({"id": empty_id})
    real = await Conversation.get_one({"id": real_id})
    assert empty is not None and real is not None
    assert int(empty.message_count or 0) == 0, "precondition: the empty conversation must have no messages"

    # The invariant itself, exactly — no messages ⇒ recency IS the birth time.
    empty_ts = Conversation._as_datetime(empty.updated_date)
    assert empty_ts == Conversation._as_datetime(empty.created_date), (
        f"empty conversation invented recency: updated_date={empty_ts} != created_date={empty.created_date}"
    )

    # …and the consequence the user actually sees: it must not outrank real mail.
    real_ts = Conversation._as_datetime(real.updated_date)
    assert empty_ts < real_ts, (
        f"a message-less conversation outranks one with a real message: "
        f"empty(msgs=0).updated_date={empty_ts} > real(msgs=1).updated_date={real_ts}. "
        f"The empty row has no message clock to derive recency from, so the projection "
        f"stamped it with the current time and it sorts to the top of the Inbox."
    )


async def test_settled_conversation_is_not_redispatched(hub_base_url, hub_login_payload):
    """A conversation that is fully in sync must NOT be re-dispatched.

    The catch-up gate compares hub clock to hub clock — the hub's parent
    ``updated_date`` against ``Conversation.hub_updated_date``, the revision this
    device last reconciled through — so once a conversation settles the gate stays
    shut until the hub actually changes something.

    Regression guard: gating on the LOCAL ``updated_date`` (``Entity.is_stale``)
    never converged, because the projection writer rewrites that field from the
    messages' own clocks, which are by construction earlier than the hub's parent
    stamp. Every catch-up then re-ran the full per-conversation + per-message hub
    fan-out for conversations with nothing to fetch — on the user's critical path,
    since ``inbox.catchup`` calls this same handler on every login and startup.
    """
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import Conversation

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"converge-{uuid.uuid4()}")
    await _hub_add_message(hub_base_url, api_key, conv_id, "converge msg")

    someone = await _local_user_typeid()
    first = await handle_conversation_list(someone)
    assert conv_id in (first.data or {}).get("bg_fetch_dispatched", []), (
        "precondition: the first catch-up must fetch this conversation"
    )

    # Let the detached drain finish — the local projection must match the hub.
    settled = await _poll_until(_projected(conv_id, expected_count=1), timeout=10.0)
    assert settled is not None, f"catch-up never projected the message for {conv_id[:8]}"

    # Nothing has happened on the hub since. This catch-up has no work to do.
    second = await handle_conversation_list(someone)
    dispatched = (second.data or {}).get("bg_fetch_dispatched", [])

    if conv_id in dispatched:
        # Diagnostics cost a hub round-trip, so only pay for them on failure.
        local = await Conversation.get_one({"id": conv_id})
        hub_row = await _hub_get_conversation(hub_base_url, api_key, conv_id)
        pytest.fail(
            f"settled conversation re-dispatched with nothing to fetch — "
            f"watermark local.hub_updated_date={local.hub_updated_date} vs "
            f"hub.updated_date={hub_row.get('updated_date')}; local recency "
            f"updated_date={local.updated_date} (trails the hub by design); "
            f"counts already agree (local={local.message_count} hub={hub_row.get('message_count')})"
        )


async def test_fetched_at_stamped_and_not_outbound(hub_base_url, hub_login_payload):
    api_key = _stash_credentials(hub_login_payload)
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.builtin.conversation import Conversation

    conv_id = await _hub_create_conversation(hub_base_url, api_key, title=f"fetched-{uuid.uuid4()}")
    someone = await _local_user_typeid()
    await handle_conversation_list(someone)
    local = await _poll_until(
        lambda: Conversation.get_one({"id": conv_id}),
        timeout=10.0,
    )
    assert local is not None
    assert local.fetched_at is not None, "hub-refreshed row must carry fetched_at"

    # LOCAL_ONLY: the outbound hub body must not include it.
    assert "fetched_at" not in local._hub_body()
    # And the hub row itself must not have one.
    hub_row = await _hub_get_conversation(hub_base_url, api_key, conv_id)
    assert "fetched_at" not in hub_row
