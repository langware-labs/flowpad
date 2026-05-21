"""Hub matrix test: HTTP send + WS receive + bundle upload + bundle download.

Walks the four FlowMessage transport surfaces against a real local hub in one
story so the header/body split is pinned end-to-end:

  1. **HTTP send header**  — alice POSTs ``add_message`` on the shared conv;
     hub returns the persisted FlowMessage.
  2. **WS receive header** — bob's raw ``websockets`` subscription captures
     the matching ``data_op_msg(create, to_entity=flow_message)`` frame.
  3. **Upload body**       — alice authors a skill + agent locally, indexes,
     then creates a *separate* hub FM carrying both as ``TYPE_ID`` attachments,
     packs locally, uploads the ``.flowmsg`` zip via ``fs/upload``, and stamps
     ``attachment_filename`` via PUT.
  4. **Download body**     — alice's local asset state is torn down. Bob
     downloads, ``unpack_bundle`` restores ``.claude/<…>`` under ``bob_dest``
     and re-indexes; we assert FS + Record + FTS5 are all back.

Skips when:
  - The local hub isn't reachable (handled by hub_tests/conftest.py).
  - ``flowpad-app/.env.local`` doesn't carry bob's creds.

Uses raw ``httpx`` + ``websockets`` (mirrors ``test_two_client_loop`` /
``test_share_with_recipients``) so alice/bob auth doesn't fight a singleton
keyring. Credentials are swapped via ``save_credentials`` only when SDK
helpers (``hub_post`` / ``_upload_bundle_to_hub`` / ``_download_and_unpack_bundle``)
need to run.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
import websockets

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db import get_db_driver
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.agent_record import AgentRecord
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.agent import agent_fn
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.utils.hub import hub_get

REPO_OSS = Path("/Users/shlom/Documents/dev/flowpad-oss")
REPO_APP = Path("/Users/shlom/Documents/dev/flowpad-app")

_SKILL_NAME = "matrix-skill"
_AGENT_NAME = "matrix-agent"
_SKILL_DESCRIPTION = "matrix round-trip skill"
_AGENT_DESCRIPTION = "matrix round-trip agent"


def _read_env_local(repo: Path) -> dict[str, str]:
    """Tiny KEY=value parser — mirrors test_two_client_loop._read_env_local."""
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


async def _login(hub_base_url: str, email: str, password: str) -> tuple[str, dict]:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/login",
            json={"email": email, "password": password},
        )
    r.raise_for_status()
    data = r.json()["data"]
    token = data.get("api_key") or data["token"]
    return token, data.get("user") or {}


def _make_ws_url(hub_base_url: str) -> str:
    base_ws = hub_base_url.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base_ws}/api/v1/connect/ws/{uuid.uuid4()}"


def _set_creds(token: str, user: dict) -> None:
    """Swap the in-memory keyring to a given identity. SDK helpers
    (hub_post / hub_get / hub_put / pack-and-upload) authenticate via
    load_credentials → keyring, so this drives whose token gets sent."""
    save_credentials(UserHubCredentials(api_key=token, user=user))


def _write_skill_and_agent(root: Path) -> tuple[Path, Path]:
    skill_dir = root / ".claude" / "skills" / _SKILL_NAME
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {_SKILL_NAME}\ndescription: {_SKILL_DESCRIPTION}\n---\nbody one",
        encoding="utf-8",
    )
    agent_path = root / ".claude" / "agents" / f"{_AGENT_NAME}.md"
    agent_path.parent.mkdir(parents=True, exist_ok=True)
    agent_path.write_text(
        f"---\nname: {_AGENT_NAME}\ndescription: {_AGENT_DESCRIPTION}\n---\nbody two",
        encoding="utf-8",
    )
    return skill_dir, agent_path


def _build_local_indexer(root: Path) -> FSIndexer:
    """Minimal indexer with skill_fn + agent_fn registered on USER_HOME_FOLDER."""
    idx = FSIndexer(
        roots=[FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user")]
    )
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    idx.add_function(RecordType.USER_HOME_FOLDER, agent_fn)
    return idx


async def _clear_local_asset_state() -> None:
    """Drop SKILL + AGENT DB rows and their on-disk shadow dirs.

    Mirrors tests/unit/test_flow_message_skill_agent_roundtrip._clear_asset_state.
    Lets the bob-side unpack+reindex be visibly the cause of state being back.
    """
    import shutil as _shutil

    from flow_sdk.fs_store.record import get_default_records_root

    driver = get_db_driver()
    for rt in (RecordType.SKILL, RecordType.AGENT):
        await driver.delete_entities_by_type(str(rt))
        shadow_dir = get_default_records_root() / str(rt)
        if shadow_dir.exists():
            _shutil.rmtree(shadow_dir, ignore_errors=True)


async def _fts_ids(query: str) -> list[str]:
    """Return entity ids whose FTS5 row matches ``query``."""
    driver = get_db_driver()
    rows = await driver.fts_search(query, limit=50)
    return [getattr(r, "id", None) for r in rows if getattr(r, "id", None)]


async def _alice_setup_shared_conversation(
    hub_base_url: str, alice_headers: dict, bob_headers: dict, bob_email: str,
) -> str:
    """Standard share/invite/accept/join chain. Returns the conversation id."""
    async with httpx.AsyncClient(timeout=5.0) as h:
        # Alice creates + joins.
        title = f"matrix-{int(time.time())}"
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation",
            headers=alice_headers, json={"title": title},
        )
        r.raise_for_status()
        conv_id = r.json()["data"]["id"]
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=alice_headers, json={},
        )
        r.raise_for_status()

        # Alice invites bob.
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members",
            headers=alice_headers,
            json={
                "recipient_email": bob_email,
                "invitation_targets": [
                    {"typeid": f"conversation-{conv_id}", "role": "member"},
                ],
            },
        )
        r.raise_for_status()

        # Bob accepts + joins.
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/invitation/pending", headers=bob_headers,
        )
        r.raise_for_status()
        pending = r.json()["data"] or []
        matching = [
            inv for inv in pending
            if inv.get("recipient_email") == bob_email and not inv.get("accepted")
        ]
        assert matching, f"bob has no pending invitation; got {pending}"
        matching.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        invitation_id = matching[0]["id"]

        r = await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=bob_headers, params={"invitation-id": invitation_id},
        )
        r.raise_for_status()

        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=bob_headers, json={},
        )
        r.raise_for_status()

    return conv_id


async def _await_fm_create(
    events: asyncio.Queue, expected_fm_id: str, timeout: float = 10.0,
) -> dict:
    """Drain ``events`` until a flow_message-create frame for ``expected_fm_id``
    arrives, then return that frame. Raises asyncio.TimeoutError on no match."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"no flow_message-create for fm={expected_fm_id} within {timeout}s")
        msg = await asyncio.wait_for(events.get(), timeout=remaining)
        if msg.get("message_type") != "data_op_msg" or msg.get("op") != "create":
            continue
        to = msg.get("to_entity")
        etype = to.split("-", 1)[0] if isinstance(to, str) else (to or {}).get("type")
        if etype != "flow_message":
            continue
        data = msg.get("data") or {}
        if (data.get("id") or "") == expected_fm_id:
            return msg


async def _await_fm_update(
    events: asyncio.Queue,
    expected_fm_id: str,
    expected_status: str,
    timeout: float = 5.0,
) -> dict:
    """Drain until a flow_message-update frame for ``expected_fm_id`` arrives
    with ``delivery_status == expected_status``."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise asyncio.TimeoutError(
                f"no flow_message-update (status={expected_status}) for fm={expected_fm_id} within {timeout}s"
            )
        msg = await asyncio.wait_for(events.get(), timeout=remaining)
        if msg.get("message_type") != "data_op_msg" or msg.get("op") != "update":
            continue
        to = msg.get("to_entity")
        etype = to.split("-", 1)[0] if isinstance(to, str) else (to or {}).get("type")
        if etype != "flow_message":
            continue
        data = msg.get("data") or {}
        if (data.get("id") or "") != expected_fm_id:
            continue
        if (data.get("delivery_status") or "") != expected_status:
            continue
        return msg


async def _await_fm_create_by_text(
    events: asyncio.Queue,
    expected_text: str,
    expected_sender_id: str,
    timeout: float = 5.0,
) -> dict:
    """Drain until a flow_message-create frame matches ``text`` + ``sender_id``.

    Used when the caller doesn't know the new FM id yet (e.g. WS-send where
    the response comes back on the *sender's* socket, but we want to wait on
    the *receiver's*)."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise asyncio.TimeoutError(
                f"no flow_message-create text={expected_text!r} sender={expected_sender_id} within {timeout}s"
            )
        msg = await asyncio.wait_for(events.get(), timeout=remaining)
        if msg.get("message_type") != "data_op_msg" or msg.get("op") != "create":
            continue
        to = msg.get("to_entity")
        etype = to.split("-", 1)[0] if isinstance(to, str) else (to or {}).get("type")
        if etype != "flow_message":
            continue
        data = msg.get("data") or {}
        if data.get("text") == expected_text and data.get("sender_id") == expected_sender_id:
            return msg


async def _ws_add_message(ws, conv_id: str, body: dict) -> str:
    """Send a ``rest_api_msg`` WS frame invoking ``conversation/<id>/add_message``.

    Returns the request's message_id so callers can correlate the
    ``response_msg`` if they want; most tests just observe the resulting
    data_op_msg(create) fanout instead."""
    msg_id = str(uuid.uuid4())
    await ws.send(json.dumps({
        "message_id": msg_id,
        "message_type": "rest_api_msg",
        "method": "POST",
        "scope": [],
        "target_typeid": {"type": "conversation", "id": conv_id},
        "action": "add_message",
        "body": body,
    }))
    return msg_id


async def _ws_collector(
    hub_base_url: str, token: str, ready: asyncio.Future, events: asyncio.Queue,
) -> None:
    """Connect WS, resolve ``ready`` with the open socket, then pump every
    frame into ``events`` so the test can both send on the socket and wait
    for specific frames."""
    url = _make_ws_url(hub_base_url)
    headers = {"Authorization": f"Bearer {token}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        if not ready.done():
            ready.set_result(ws)
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            await events.put(msg)


async def _ensure_bob_app_connected(bob_env: dict, bob_email: str) -> str:
    """Drive bob's running flowpad app to env-mode login + hub WS connect, so
    its *real* hub_bridge auto-acks delivery in cell 2b (the test no longer
    POSTs mark_delivered itself). Mirrors docker/run_realtime_tests.sh.

    Returns bob's app base url. Skips the test — not fails — when bob's app
    isn't running or can't reach a hub-connected state: without it the
    auto-ack simply can't fire, which is an environment gap, not a bug."""
    port = (bob_env.get("LOCAL_SERVER_PORT") or "").strip()
    if not port:
        pytest.skip("bob .env.local missing LOCAL_SERVER_PORT — can't locate bob's app")
    app_url = f"http://localhost:{port}"

    async with httpx.AsyncClient(timeout=5.0) as h:
        try:
            await h.get(f"{app_url}/api/v1/cloud/status")
        except Exception as e:
            pytest.skip(f"bob's flowpad app not running on :{port} ({e}) — needed for auto-ack")

        # Env-mode login ({} body → app reads its own FLOWPAD_CLOUD_USER_*),
        # then explicitly kick the hub WS bridge to connect.
        await h.post(f"{app_url}/api/v1/cloud/login", json={})
        await h.post(f"{app_url}/api/v1/cloud/ws/connect", json={})

        # Poll cloud/status until the bridge reports a verified hub connection.
        deadline = asyncio.get_event_loop().time() + 10.0
        while True:
            r = await h.get(f"{app_url}/api/v1/cloud/status")
            data = (r.json() or {}).get("data") or {}
            if data.get("hub_ws_connected") and data.get("logged_in"):
                got = ((data.get("user") or {}).get("email") or "")
                if got != bob_email:
                    pytest.skip(f"bob's app logged in as {got!r}, expected {bob_email!r}")
                return app_url
            if asyncio.get_event_loop().time() >= deadline:
                pytest.skip(
                    f"bob's app on :{port} did not reach hub-connected state "
                    f"(status={data.get('hub_ws_status')!r}) — auto-ack can't fire"
                )
            await asyncio.sleep(0.5)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_matrix_http_ws_upload_download(
    tmp_path: Path, hub_base_url, isolated_hub_keyring,
) -> None:
    # ── Setup ───────────────────────────────────────────────────────────────
    # Load creds from each repo's .env.local. Skip if either is missing.
    alice_env = _read_env_local(REPO_OSS)
    bob_env = _read_env_local(REPO_APP)
    if not (alice_env.get("FLOWPAD_CLOUD_USER_EMAIL") and bob_env.get("FLOWPAD_CLOUD_USER_EMAIL")):
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-oss or flowpad-app .env.local")

    # Log both users in (POST /api/v1/login); keep their JWT tokens + user ids.
    alice_token, alice_user = await _login(
        hub_base_url, alice_env["FLOWPAD_CLOUD_USER_EMAIL"], alice_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    bob_token, bob_user = await _login(
        hub_base_url, bob_env["FLOWPAD_CLOUD_USER_EMAIL"], bob_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    alice_id, bob_id = alice_user["id"], bob_user["id"]
    print(f"\nalice {alice_id[:8]}  bob {bob_id[:8]}")

    # Build auth headers (Bearer <token>); reused in every REST call below.
    headers_a = {"Authorization": f"Bearer {alice_token}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    # Alice creates a conversation, invites bob, bob accepts + joins. Returns conv id.
    conv_id = await _alice_setup_shared_conversation(
        hub_base_url, headers_a, headers_b, bob_env["FLOWPAD_CLOUD_USER_EMAIL"],
    )
    print(f"conv {conv_id[:8]} ready")

    # Bob's real flowpad app must be logged in + hub-connected so its hub_bridge
    # auto-acks delivery in cell 2b — the test no longer POSTs mark_delivered.
    bob_app_url = await _ensure_bob_app_connected(bob_env, bob_env["FLOWPAD_CLOUD_USER_EMAIL"])
    print(f"bob app connected: {bob_app_url}")

    # Open both WS sockets *before* cell 1 so create frames are captured.
    # The collector resolves ``ready`` with the open ws so the test can
    # send outbound frames (cells 2c, 3 header, 4b) on the same socket.
    bob_events: asyncio.Queue = asyncio.Queue()
    bob_ready: asyncio.Future = asyncio.Future()
    bob_ws_task = asyncio.create_task(
        _ws_collector(hub_base_url, bob_token, bob_ready, bob_events)
    )
    alice_events: asyncio.Queue = asyncio.Queue()
    alice_ready: asyncio.Future = asyncio.Future()
    alice_ws_task = asyncio.create_task(
        _ws_collector(hub_base_url, alice_token, alice_ready, alice_events)
    )
    try:
        # Wait until both sockets are connected, plus a tiny grace period
        # so the WS upgrade is fully done before any traffic flows.
        bob_ws = await asyncio.wait_for(bob_ready, timeout=5.0)
        alice_ws = await asyncio.wait_for(alice_ready, timeout=5.0)
        await asyncio.sleep(0.1)

        # ── Cell 1: HTTP send header ────────────────────────────────────────
        # Alice POSTs a text message to the conversation; raise on non-2xx.
        async with httpx.AsyncClient(timeout=5.0) as h:
            r = await h.post(
                f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
                headers=headers_a, json={"text": "cell-1-http"},
            )
        r.raise_for_status()
        # Grab the new FM id from the response — we'll watch for it on bob's WS next.
        fm_http_id = r.json()["data"]["id"]
        assert fm_http_id, "add_message response missing flow_message id"
        print(f"cell 1 (HTTP send): fm={fm_http_id[:8]}")

        # ── Cell 2: WS receive header ───────────────────────────────────────
        # Bob's socket must see the message arrive as a data_op_msg(create);
        # assert the text + sender match what alice sent over REST.
        ev = await _await_fm_create(bob_events, fm_http_id, timeout=5.0)
        ev_data = ev["data"] or {}
        assert ev_data.get("text") == "cell-1-http", f"WS data.text mismatch: {ev_data!r}"
        assert ev_data.get("sender_id") == alice_id, f"WS sender mismatch: {ev_data.get('sender_id')!r}"
        print("cell 2 (WS receive): payload matches sender + text")

        # ── Cell 2b: ack lifecycle (auto-delivered → explicit received) ────
        # Delivered ack: the test does NOT send this. Bob's running flowpad app
        # received the message and its real hub_bridge._on_data_op auto-fired
        # mark_delivered. Alice (sender) sees the delivery fanout on her WS —
        # this pins the real SDK auto-ack, not a test-driven POST. delivered_at
        # is set; received_at still empty (only step 1 of the state machine).
        ev = await _await_fm_update(alice_events, fm_http_id, "delivered", timeout=10.0)
        ev_data = ev["data"] or {}
        assert ev_data.get("delivered_at"), f"delivered_at missing: {ev_data!r}"
        assert ev_data.get("received_at") is None, f"received_at set too early: {ev_data!r}"
        print("cell 2b (auto-ack): delivered fanout from bob's app")

        # Received ack: still explicit — nothing in the product auto-fires it
        # (the UI's "mark read" toggles a separate local-only is_read field).
        # Bob POSTs mark_received; hub stamps received_at.
        async with httpx.AsyncClient(timeout=5.0) as h:
            r = await h.post(
                f"{hub_base_url}/api/v1/graph/flow_message/mark_received",
                headers=headers_b, json={"flow_message_ids": [fm_http_id]},
            )
        r.raise_for_status()
        ack_body = r.json().get("data") or {}
        assert ack_body.get("updated") == [fm_http_id], f"mark_received body: {ack_body!r}"

        # Alice sees the read fanout on her WS; received_at now populated.
        ev = await _await_fm_update(alice_events, fm_http_id, "received", timeout=5.0)
        ev_data = ev["data"] or {}
        assert ev_data.get("received_at"), f"received_at missing: {ev_data!r}"
        print("cell 2b (acks): delivered (auto, bob's app) + received (explicit)")

        # ── Cell 2c: Bob replies with text over WS ─────────────────────────
        # Bob sends a flow_message via his open WS socket (no REST).
        await _ws_add_message(bob_ws, conv_id, {"text": "cell-2c-ws-reply"})
        # Alice's WS should see Bob's reply arrive as a data_op_msg(create).
        ev = await _await_fm_create_by_text(alice_events, "cell-2c-ws-reply", bob_id, timeout=5.0)
        fm_bob_reply_id = (ev.get("data") or {}).get("id")
        assert fm_bob_reply_id, f"bob's WS reply missing fm id: {ev!r}"
        print(f"cell 2c (WS send): fm={fm_bob_reply_id[:8]} from bob")

        # Alice authors a skill + agent on disk under a temp .claude/ tree and
        # runs the indexer so her local DB has Records for both.
        src_root = tmp_path / "alice_src"
        skill_dir, agent_path = _write_skill_and_agent(src_root)
        await _build_local_indexer(src_root).index(IndexerOptions(verbose=False, force=True))
        # Capture the local ids and sanity-check both Records are present.
        skill_id = SkillRecord.load_record(skill_dir).id
        agent_id = Entity.allocate_id({"id": _AGENT_NAME, "type": str(RecordType.AGENT)})
        assert SkillRecord.get(skill_id) is not None
        assert AgentRecord.get(agent_id) is not None

        # ── Cell 3: skill via WS (header) + REST (body upload) ─────────────
        # Switch SDK keyring to alice so the REST upload helper below auths as her.
        _set_creds(alice_token, alice_user)

        # Build a FlowMessage carrying skill+agent as TYPE_ID attachments.
        fm_bundle = FlowMessage(text="cell-3-bundle", attachment=[])
        fm_bundle.attachment = [
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{skill_id}"),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"agent-{agent_id}"),
        ]
        hub_payload: dict[str, Any] = fm_bundle.model_dump(
            mode="python", context={"skip_api_serializer": True},
        )

        # WS header send: route through ``conversation/<id>/add_message`` over
        # alice's open socket. The action grants participants read on the new
        # FM (so bob's blob GET in cell 4 won't 401), same as REST add_message.
        await _ws_add_message(alice_ws, conv_id, hub_payload)
        # Wait for the create frame on alice's own queue (sender-side fanout)
        # to learn the hub-assigned FM id.
        ev = await _await_fm_create_by_text(alice_events, "cell-3-bundle", alice_id, timeout=5.0)
        hub_fm_id = (ev.get("data") or {}).get("id")
        assert hub_fm_id, f"WS add_message missing fm id: {ev!r}"
        # Align local & hub ids so pack carries the hub id into the bundle.
        fm_bundle.id = hub_fm_id

        # REST body upload: zip alice's local .claude/ assets into a .flowmsg
        # blob and POST it via the production helper (exercises real path).
        # ``fm.upload_body()`` is the production path used by the conversation
        # transport: pack_bundle → POST flow_message/<id>/fs/upload → set_body_status.
        await fm_bundle.upload_body()

        # GET the FM back and assert attachment_filename was stamped — proves
        # the body upload landed on the hub.
        hub_fm_after = await hub_get(BuiltinEntityType.FLOW_MESSAGE, hub_fm_id)
        assert hub_fm_after, "hub_get returned no FM after upload"
        attachment_filename = (hub_fm_after.get("attachment_filename") or "").strip()
        assert attachment_filename, f"hub FM did not get stamped: {hub_fm_after!r}"
        print(f"cell 3 (upload): hub_fm={hub_fm_id[:8]} filename={attachment_filename}")

        # ── Cell 4: download body, unpack, reindex (bob side) ──────────────
        # Wipe alice's local state (files + DB rows) so bob's restore is provably
        # the reason the records come back later.
        import shutil as _shutil
        _shutil.rmtree(src_root / ".claude")
        await _clear_local_asset_state()
        assert SkillRecord.get(skill_id) is None
        assert AgentRecord.get(agent_id) is None

        # Switch SDK keyring to bob so the download helper auths as him.
        _set_creds(bob_token, bob_user)

        # Fresh empty destination folder for bob's unpack.
        bob_dest = tmp_path / "bob_dest"
        bob_dest.mkdir()

        # Bob downloads the .flowmsg blob via REST and unzips into bob_dest.
        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
        success = await _download_and_unpack_bundle(
            hub_fm_id, attachment_filename, asset_dest_root=bob_dest,
        )
        assert success, "bob bundle download/unpack returned False"

        # Filesystem layer: skill markdown and agent file landed in the expected paths.
        restored_skill = bob_dest / ".claude" / "skills" / _SKILL_NAME / "SKILL.md"
        restored_agent = bob_dest / ".claude" / "agents" / f"{_AGENT_NAME}.md"
        assert restored_skill.exists(), f"skill FS subtree not restored at {restored_skill}"
        assert restored_agent.exists(), f"agent FS file not restored at {restored_agent}"
        # DB layer: Records are back. FTS layer: full-text search returns them.
        assert SkillRecord.get(skill_id) is not None, "skill not reindexed after unpack"
        assert AgentRecord.get(agent_id) is not None, "agent not reindexed after unpack"
        assert skill_id in await _fts_ids(_SKILL_DESCRIPTION), "skill missing from FTS after unpack"
        assert agent_id in await _fts_ids(_AGENT_DESCRIPTION), "agent missing from FTS after unpack"
        print("cell 4 (download+unpack+reindex): FS + Record + FTS all restored")

        # ── Cell 4b: Bob replies "thanks" via WS ───────────────────────────
        # Bob sends a thank-you flow_message over his WS after the skill landed.
        await _ws_add_message(bob_ws, conv_id, {"text": "cell-4b-thanks"})
        # Alice's WS should see bob's thanks arrive as a data_op_msg(create).
        ev = await _await_fm_create_by_text(alice_events, "cell-4b-thanks", bob_id, timeout=5.0)
        fm_bob_thanks_id = (ev.get("data") or {}).get("id")
        assert fm_bob_thanks_id, f"bob's thanks missing fm id: {ev!r}"
        print(f"cell 4b (WS send): fm={fm_bob_thanks_id[:8]} thanks from bob")
    finally:
        # Close both WS background tasks so the test doesn't leak sockets.
        for task in (bob_ws_task, alice_ws_task):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
