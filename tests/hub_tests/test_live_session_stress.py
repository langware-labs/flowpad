"""Live-session STRESS over a real local hub: 20 prompts, 2 sessions, one host.

bob (raw HTTP, the GUEST) fires twenty prompts back-to-back into one shared
conversation, alternating between two guest-minted session ids. alice (this
process, the HOST) receives them over her real hub WebSocket bridge, which
routes each through ``process_inbound_prompt``; a standing grant pre-approves
both sessions; the worker seam is a fast fake so the test measures the
transport + gate + per-session serialization, not an LLM.

Asserts: exactly one completion per prompt, ten per session, replies in each
session's send order, no cross-session leakage, ONE host process for the
conversation, and no ``database is locked`` anywhere in the log.

Prompts ride the mirrored ``remote_worker_session_id`` header with an inline
prompt attachment (no body bundle) so the hub fans them out immediately.

# do not increase timeout without approval
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from tests.hub_tests._assignment import assert_auto_assigned

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval

REPO_APP = Path(__file__).resolve().parents[2].parent / "flowpad-app"
PROMPTS_PER_SESSION = 10


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


async def _bob(hub_base_url: str) -> tuple[dict, str, str]:
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
    return ({"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, bob_email, (data.get("user") or {})["id"])


def _completions(fms: list[FlowMessage]) -> list[FlowMessage]:
    return [
        m for m in fms
        if any(a.attachment_type == AttachmentType.TYPE_ID and (a.data or "").startswith("prompt_completion-")
               for a in (m.attachment or []))
    ]


@pytest.mark.asyncio
async def test_twenty_prompts_two_sessions_one_host(
    hub_base_url, hub_login_payload, isolated_hub_keyring, monkeypatch, caplog, tmp_path,
) -> None:
    from flow_sdk.app.actions import execute_prompt as ep
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.project import Project
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from tests.hub_tests._local_login import login_as

    caplog.set_level(logging.WARNING)
    login_as(hub_login_payload)
    headers_b, bob_email, bob_id = await _bob(hub_base_url)

    # ── fast fake worker: the turn engine is real, the LLM is not ──────────
    prompts_seen: list[str] = []

    async def fake_prompt(self, text, *a, **k):
        prompts_seen.append(text)
        await asyncio.sleep(0.005)

    async def fake_capture(ap):
        last = prompts_seen[-1] if prompts_seen else ""
        return last.split("\n", 1)[0]  # echo the prompt's first line

    monkeypatch.setattr(AgenticProcess, "prompt", fake_prompt)
    monkeypatch.setattr(ep, "_capture_assistant_reply", fake_capture)

    # ── host side: a project-mapped, shared conversation + standing grant ──
    host_root = tmp_path / "host-project"
    host_root.mkdir()
    local_project = Project(name="live-session-stress-host", fs_storage_mount_path=str(host_root))
    await local_project.save(notify=False)
    conv = Conversation(title=f"live-session-stress-{int(time.time())}-{uuid.uuid4().hex[:6]}",
                        project_id=local_project.id)
    await conv.share(recipients=[bob_email])
    assert conv.remote is True
    await conv.save(notify=False)
    token_b = headers_b["Authorization"].removeprefix("Bearer ")
    await assert_auto_assigned(hub_base_url, token_b, entity_type="conversation", entity_id=conv.id,
                               user_id=bob_id, expected_role="member")
    alice_key = hub_login_payload.get("api_key") or hub_login_payload.get("token")
    headers_a = {"Authorization": f"Bearer {alice_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        # Both sides must be PARTICIPANTS: the hub fans a message out only to
        # them, and alice's bridge is what routes bob's prompts to the gate.
        for hdrs in (headers_a, headers_b):
            r = await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join", headers=hdrs, json={})
            assert r.status_code < 300, r.text

    grant = ContactPermission(contact_user_id=bob_id, project_id=None,
                              allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value])
    await grant.save(notify=False)

    # The server installs the bridge's inbound handler at startup; in-process
    # the test does the same, else the WS frames are received and dropped.
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge

    hub_ws_bridge.install()
    status = await hub_ws_manager.restart(wait_connected=True)
    assert status.get("hub_ws_connected") is True, status

    session_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    expected: dict[str, list[str]] = {sid: [] for sid in session_ids}
    try:
        # ── guest side: 20 prompts back-to-back, alternating sessions ────
        t0 = time.monotonic()
        async with httpx.AsyncClient(timeout=10.0) as h:
            for i in range(PROMPTS_PER_SESSION * 2):
                sid = session_ids[i % 2]
                line = f"S{i % 2} #{i // 2}"
                expected[sid].append(line)
                r = await h.post(
                    f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/add_message",
                    headers=headers_b,
                    json={
                        "text": line,
                        "remote_worker_session_id": sid,
                        "attachment": [{"attachment_type": AttachmentType.PROMPT.value, "data": line}],
                    },
                )
                assert r.status_code < 300, r.text
        sent_in = time.monotonic() - t0

        # ── host side: wait for every completion (bounded poll, no sleeps) ─
        deadline = time.monotonic() + 40.0
        done: list[FlowMessage] = []
        while time.monotonic() < deadline:
            fms = await FlowMessage.get_all({"conversation_id": conv.id})
            done = _completions(fms)
            if len(done) >= PROMPTS_PER_SESSION * 2:
                break
            await asyncio.sleep(0.2)
        settled_in = time.monotonic() - t0
        print(f"[stress] sent 20 prompts in {sent_in:.2f}s; 20 completions settled in {settled_in:.2f}s")

        assert len(done) == PROMPTS_PER_SESSION * 2, f"{len(done)} completions"
        for sid in session_ids:
            mine = sorted((m for m in done if m.remote_worker_session_id == sid), key=lambda m: m.created_date or "")
            assert len(mine) == PROMPTS_PER_SESSION, (
                f"session {sid[:8]}: {[(m.id[:8], m.text[:40], m.sender_id and m.sender_id[:8]) for m in mine]}"
            )
            got = [m.text.split('"')[1] for m in mine]  # Prompt response: "<line>"
            assert got == expected[sid], f"session {sid[:8]} order: {got}"
            session = await RemoteWorkerSession.get_one({"id": sid})
            assert session is not None and session.approved_via == "standing_grant"
            assert session.starting_message_id
        assert len(prompts_seen) == PROMPTS_PER_SESSION * 2
        procs = await AgenticProcess.get_all({"target_typeid_str": f"conversation-{conv.id}"})
        assert len(procs) == 1, [p.id for p in procs]
        assert "database is locked" not in caplog.text
    finally:
        await hub_ws_manager.stop()
        await grant.delete()
