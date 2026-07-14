"""Live-session transport loop against a live local hub (Phase 3).

Proves the hub-optional wire contract end-to-end with two real identities —
alice (in-process SDK, the HOST) and bob (raw HTTP, the GUEST):

  1. alice shares a conversation with bob (canonical invite → accept → join).
  2. GUEST → HOST: bob posts a prompt message carrying the guest-minted session
     id — the ``remote_worker_session-<id>`` TYPE_ID attachment is the
     authoritative carrier; the test asserts ``derive_session_fields`` recovers
     the session id and SESSION_EVENT kind from the wire payload REGARDLESS of
     whether the hub schema mirrors the new header fields yet (F1), and logs
     which carrier was live so the eventual hub upgrade is observable.
  3. HOST → GUEST: alice sends a SESSION_EVENT through the full add_message +
     body-bundle path; bob downloads the bundle bytes through the hub blob
     store; the zip provably contains the session snapshot header (whitelist
     only — no host-local fields).
  4. Receiver materialization: with alice's local session row wiped,
     ``unpack_bundle`` of those bytes re-materializes the session row — the
     message-borne snapshot is sufficient, no hub entity sync involved.

Auto-skips without a local hub (conftest) or bob credentials.

# do not increase timeout without approval
"""
from __future__ import annotations

import json
import os
import time
import uuid
import zipfile
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.flow_message import (
    AttachmentType,
    BodyStatus,
    FlowMessage,
    FlowMessageKind,
    derive_session_fields,
)
from flow_sdk.builtin.flow_message_bundle import unpack_bundle
from flow_sdk.builtin.remote_worker_session import (
    RemoteWorkerSession,
    RemoteWorkerSessionStatus as S,
)

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval

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


async def _bob_headers(hub_base_url: str) -> dict:
    app_env = _read_env_local(REPO_APP)
    bob_email = os.environ.get("BOB_EMAIL") or app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = os.environ.get("BOB_PW") or app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not bob_email or not bob_pw:
        pytest.skip("missing BOB_EMAIL/BOB_PW and flowpad-app fallback credentials")
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": bob_email, "password": bob_pw})
        r.raise_for_status()
        data = r.json()["data"]
    token = data.get("api_key") or data["token"]
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-Bob-Email": bob_email,  # test-local convenience, stripped below
    }


async def _accept_and_join(hub_base_url: str, headers_b: dict, conv_id: str, bob_email: str) -> None:
    """Canonical recipient flow: pending → accept (302-tolerant) → join."""
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = [
            inv for inv in (r.json()["data"] or [])
            if inv.get("recipient_email") == bob_email
        ]
        assert pending, "bob has no pending invitation"
        pending.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=headers_b,
            params={"invitation-id": pending[0]["id"]},
        )
        if r.status_code in (301, 302, 303, 307, 308):
            location = (r.headers.get("location") or "")
            assert "login" not in location.lower(), f"accept bounced to login: {location[:200]}"
        else:
            r.raise_for_status()
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join",
            headers=headers_b, json={},
        )
        assert r.status_code < 300, r.text


@pytest.mark.asyncio
async def test_live_session_transport_loop(
    hub_base_url, hub_login_payload, isolated_hub_keyring, tmp_path,
) -> None:
    from tests.hub_tests._local_login import login_as
    from flow_sdk.builtin.conversation import Conversation

    login_as(hub_login_payload)
    alice_key = hub_login_payload.get("api_key") or hub_login_payload.get("token")
    alice_hub_id = (hub_login_payload.get("user") or {}).get("id")
    headers_a = {"Authorization": f"Bearer {alice_key}", "Content-Type": "application/json"}

    headers_b = await _bob_headers(hub_base_url)
    bob_email = headers_b.pop("X-Bob-Email")

    # ── 1. share the conversation (invite → accept → join) ──────────────────
    conv = Conversation(title=f"live-session-loop-{int(time.time())}-{uuid.uuid4().hex[:6]}")
    await conv.share(recipients=[bob_email])
    assert conv.remote is True
    await conv.save(notify=False)  # persist remote=True for the local send path
    await _accept_and_join(hub_base_url, headers_b, conv.id, bob_email)

    # The guest-minted live-session id (uuid4 — must pass validate-on-adopt).
    sid = str(uuid.uuid4())
    carrier = f"remote_worker_session-{sid}"

    # ── 2. GUEST → HOST: bob's prompt rides the carrier attachment ─────────
    async with httpx.AsyncClient(timeout=10.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/add_message",
            headers=headers_b,
            json={
                "text": "please run the tests on your machine",
                "remote_worker_session_id": sid,  # header field — may be dropped (F1)
                "attachment": [
                    {"attachment_type": AttachmentType.PROMPT.value, "data": "run the tests"},
                    {"attachment_type": AttachmentType.TYPE_ID.value, "data": carrier},
                ],
            },
        )
        assert r.status_code < 300, r.text
        bob_fm_id = r.json()["data"]["id"]

        # alice reads it back off the hub — the receiver's wire view.
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/flow_message/{bob_fm_id}", headers=headers_a,
        )
        assert r.status_code == 200, r.text
        wire = r.json()["data"]

    hub_mirrors_header = wire.get("remote_worker_session_id") == sid
    # Document which carrier was live (observable when the hub schema catches up).
    print(f"[live-session-loop] hub mirrors remote_worker_session_id header: {hub_mirrors_header}")

    inbound = FlowMessage.model_validate({
        k: v for k, v in wire.items() if k in FlowMessage.model_fields
    })
    derive_session_fields(inbound)
    # F1 pin: with OR without the hub schema mirror, the receiver recovers the id.
    assert inbound.remote_worker_session_id == sid
    att_data = [a.data for a in inbound.attachment or []]
    assert carrier in att_data, f"carrier attachment stripped by hub: {att_data}"

    # ── 3. HOST → GUEST: SESSION_EVENT + snapshot through the blob store ────
    host_session = RemoteWorkerSession(
        conversation_id=conv.id,
        host_user_id=alice_hub_id,
        guest_user_id="bob-hub-id",
        host_name="Alice",
        guest_name="Bob",
        status=S.IDLE.value,
        last_activity_at="2026-07-14T10:00:00+00:00",
        host_process_id="ap-host-local",  # host-local — must NOT travel
        project_id="proj-host-local",
    )
    host_session.id = sid
    await host_session.save(notify=False)

    data = await conv.add_message(
        "Alice approved the live session",
        remote_worker_session_id=sid,
        kind=FlowMessageKind.SESSION_EVENT.value,
        attachments=[{
            "attachment_type": AttachmentType.TYPE_ID.value,
            "data": carrier,
            "prompt_preview": json.dumps({"live_session_event": "approved"}),
        }],
    )
    assert data.get("body_status") == BodyStatus.UPLOADING.value, data

    event_fm = FlowMessage.model_validate(data)
    derive_session_fields(event_fm)
    assert event_fm.remote_worker_session_id == sid
    assert event_fm.kind == FlowMessageKind.SESSION_EVENT  # marker survives the hub
    await event_fm.upload_body()
    assert event_fm.body_status == BodyStatus.READY

    # bob pulls the row + the bundle bytes through the hub.
    async with httpx.AsyncClient(timeout=10.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/flow_message/{event_fm.id}", headers=headers_b,
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["body_status"] == "ready"
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/flow_message/{event_fm.id}/fs/download/body.flowmsg",
            headers=headers_b,
        )
        assert r.status_code == 200, r.text
        bundle_bytes = r.content
    assert bundle_bytes, "empty bundle download"

    zip_path = tmp_path / "body.flowmsg"
    zip_path.write_bytes(bundle_bytes)
    header_name = f"attachment/remote_worker_session-@{sid}/header.json"
    with zipfile.ZipFile(zip_path) as zf:
        assert header_name in zf.namelist(), zf.namelist()
        snap = json.loads(zf.read(header_name))
    assert snap["id"] == sid
    assert snap["status"] == S.IDLE.value
    assert "host_process_id" not in snap
    assert "project_id" not in snap

    # ── 4. receiver materialization: snapshot alone rebuilds the row ────────
    await host_session.delete()
    assert await RemoteWorkerSession.get_one({"id": sid}) is None
    await unpack_bundle(zip_path, local_user_id="receiver")
    restored = await RemoteWorkerSession.get_one({"id": sid})
    assert restored is not None
    assert restored.status == S.IDLE.value
    assert restored.host_name == "Alice"
    assert not restored.host_process_id  # never crosses machines

    await restored.delete()
