"""A live-session turn the host cannot run is reported to the GUEST, promptly.

Found against a fresh Windows host with no assistant installed (the shape of a
real failed session): the worker never started, the host waited the full
transcript timeout (300s) for a transcript that could not appear, marked the
session ERROR locally — and sent the guest nothing, so the guest's mirror sat
on ``running`` forever.

bob (raw HTTP, the GUEST) opens a session over the real hub; alice (this
process, the HOST) receives it through her real WebSocket bridge and the
standing-grant gate runs the turn on a worker that cannot run here:

* ``unfunded`` — opencode with no LLM source: the spawn is refused up front.
* ``not_installed`` — codex, funded by an OpenRouter key but absent from this
  box: the spawn fails in the background turn, after ``prompt`` accepted it.
  This is the path that waited 300s. Needs ``OPENROUTER_API_KEY``.

Asserts: the host session is ERROR within seconds, and the guest receives a
SESSION_EVENT naming the failure.

# do not increase timeout without approval
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
import uuid

import httpx
import pytest

from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction
from flow_sdk.builtin.flow_message import AttachmentType
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
from tests.hub_tests._assignment import assert_auto_assigned
from tests.hub_tests._guest import guest_login

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval

FAILED_LINE = "The host could not run this prompt"


@pytest.mark.asyncio
@pytest.mark.parametrize("worker", ["unfunded", "not_installed"])
async def test_a_turn_the_host_cannot_run_is_reported_to_the_guest(
    worker, hub_base_url, hub_login_payload, isolated_hub_keyring, monkeypatch, tmp_path
) -> None:
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.project import Project
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
    from flow_sdk.cloud_client.ws_client import hub_ws_manager
    from tests.hub_tests._local_login import login_as

    if worker == "unfunded":
        if shutil.which("opencode"):
            pytest.skip("opencode is installed here; it would not fail to spawn")
        monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "opencode")
    else:
        if shutil.which("codex"):
            pytest.skip("codex is installed here; it would not fail to spawn")
        if not os.environ.get("OPENROUTER_API_KEY"):
            pytest.skip("OPENROUTER_API_KEY not set — codex would be refused as unfunded, not uninstalled")
        from flow_sdk.lm_api import LMApiProvider, set_lm_api

        set_lm_api(os.environ["OPENROUTER_API_KEY"], LMApiProvider.OPENROUTER)
        monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "codex")

    login_as(hub_login_payload)
    bob = await guest_login(hub_base_url)

    root = tmp_path / "host"
    root.mkdir()
    project = Project(name=f"failed-turn-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(root))
    await project.save(notify=False)
    conv = Conversation(title=f"failed-turn-{int(time.time())}-{uuid.uuid4().hex[:6]}", project_id=project.id)
    await conv.share(recipients=[bob.email])
    await conv.save(notify=False)
    await assert_auto_assigned(hub_base_url, bob.token, entity_type="conversation", entity_id=conv.id,
                               user_id=bob.user_id, expected_role="member")
    async with httpx.AsyncClient(timeout=5.0) as h:  # alice joined inside share(); only the guest still needs to
        r = await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join", headers=bob.headers, json={})
        assert r.status_code < 300, r.text
    grant = ContactPermission(contact_user_id=bob.user_id, project_id=None,
                              allowed_actions=[PermissionAction.AUTO_APPROVE_SESSION.value])
    await grant.save(notify=False)
    hub_ws_bridge.install()
    assert (await hub_ws_manager.restart(wait_connected=True)).get("hub_ws_connected") is True

    sid = str(uuid.uuid4())
    try:
        async with httpx.AsyncClient(timeout=10.0) as h:
            r = await h.post(
                f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/add_message",
                headers=bob.headers,
                json={"text": "Commit id ?", "remote_worker_session_id": sid,
                      "attachment": [{"attachment_type": AttachmentType.PROMPT.value, "data": "Commit id ?"}]},
            )
            assert r.status_code < 300, r.text

            # Host: the turn must END in ERROR within seconds, not after the transcript timeout.
            deadline, status = time.monotonic() + 30, None
            while time.monotonic() < deadline:
                session = await RemoteWorkerSession.get_one({"id": sid})
                status = session.status if session else None
                if status == "error":
                    break
                await asyncio.sleep(0.3)
            assert status == "error", f"host session is {status!r} — the failed turn never ended"

            # Guest: told why, on the hub, as a session line.
            lines: list[str] = []
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not lines:
                r = await h.get(f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/flow_message", headers=bob.headers)
                rows = r.json().get("data") or []
                rows = rows if isinstance(rows, list) else rows.get("items", [])
                lines = [m.get("text") or "" for m in rows if FAILED_LINE in (m.get("text") or "")]
                await asyncio.sleep(0.3)
            assert lines, "the guest was never told the turn failed"
    finally:
        await hub_ws_manager.stop()
        await grant.delete()
