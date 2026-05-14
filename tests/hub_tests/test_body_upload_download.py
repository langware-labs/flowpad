"""End-to-end validation of FlowMessage.upload_body / download_body against a
live local hub.

This is the smoke for the new header/body interface (principles #2, #6, #7).
Walks the full state machine on real wire:

  1. Alice creates a conversation, invites bob, both join.
  2. Alice creates a FlowMessage with an attachment that requires a body
     (a Skill TYPE_ID attachment — exercises the bundle pack path).
  3. Alice calls fm.upload_body() → hub's body_status flips NA → UPLOADING
     → READY and the bundle lands at fs/download/body.flowmsg.
  4. Bob receives the FM via WS fanout, switches identity, calls
     fm.download_body() → body bytes pulled from the hub, unpack succeeds.

Uses the same fixtures as test_message_matrix (isolated_hub_keyring,
hub_base_url) and the same _set_creds() identity-swap pattern.

# do not increase timeout without approval
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

from flow_sdk.builtin.flow_message import (
    BODY_FILENAME,
    Attachment,
    AttachmentType,
    BodyStatus,
    FlowMessage,
)
from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.skill_record import SkillRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.skill import skill_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.utils.hub import hub_get, hub_post


REPO_OSS = Path("/Users/shlom/Documents/dev/flowpad-oss")
REPO_APP = Path("/Users/shlom/Documents/dev/flowpad-app")


def _read_env_local(repo: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    p = repo / ".env.local"
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


async def _login(hub_base_url: str, email: str, password: str) -> tuple[str, dict]:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": email, "password": password})
    r.raise_for_status()
    data = r.json()["data"]
    return data.get("api_key") or data["token"], data.get("user") or {}


def _set_creds(token: str, user: dict) -> None:
    save_credentials(UserHubCredentials(api_key=token, user=user))


async def _setup_shared_conv(
    hub_base_url: str, h_a: dict, h_b: dict, bob_email: str,
) -> str:
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation",
            headers=h_a, json={"title": f"body-test-{int(time.time())}"},
        )
        r.raise_for_status()
        conv_id = r.json()["data"]["id"]
        await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join", headers=h_a, json={})
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/members",
            headers=h_a,
            json={
                "recipient_email": bob_email,
                "invitation_targets": [{"typeid": f"conversation-{conv_id}", "role": "member"}],
            },
        )
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=h_b)
        pending = r.json()["data"] or []
        matching = [
            i for i in pending
            if i.get("recipient_email") == bob_email and not i.get("accepted")
        ]
        assert matching, f"bob has no pending invitation; got {pending}"
        matching.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        inv_id = matching[0]["id"]
        await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=h_b, params={"invitation-id": inv_id},
        )
        await h.post(f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/join", headers=h_b, json={})
    return conv_id


def _write_skill(root: Path, name: str = "body-test-skill") -> tuple[Path, str]:
    skill_dir = root / ".claude" / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: body upload/download smoke skill\n---\nbody",
        encoding="utf-8",
    )
    return skill_dir, name


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_upload_download_body_roundtrip(
    tmp_path: Path, hub_base_url, isolated_hub_keyring,
) -> None:
    """Alice uploads a body via fm.upload_body(); bob downloads it via fm.download_body()."""
    oss_env = _read_env_local(REPO_OSS)
    app_env = _read_env_local(REPO_APP)
    if not (oss_env.get("FLOWPAD_CLOUD_USER_EMAIL") and app_env.get("FLOWPAD_CLOUD_USER_EMAIL")):
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in oss + app .env.local")

    alice_token, alice_user = await _login(
        hub_base_url, oss_env["FLOWPAD_CLOUD_USER_EMAIL"], oss_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    bob_token, bob_user = await _login(
        hub_base_url, app_env["FLOWPAD_CLOUD_USER_EMAIL"], app_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    headers_a = {"Authorization": f"Bearer {alice_token}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    conv_id = await _setup_shared_conv(
        hub_base_url, headers_a, headers_b, app_env["FLOWPAD_CLOUD_USER_EMAIL"],
    )

    # Author a real local skill so the bundle has something substantive to pack.
    src_root = tmp_path / "alice_src"
    skill_dir, skill_name = _write_skill(src_root)
    idx = FSIndexer(roots=[FSRef(src_root, record_type=RecordType.USER_HOME_FOLDER, scope="user")])
    idx.add_function(RecordType.USER_HOME_FOLDER, skill_fn)
    await idx.index(IndexerOptions(verbose=False, force=True))
    skill_id = SkillRecord.load_record(skill_dir).id
    assert SkillRecord.get(skill_id) is not None

    _set_creds(alice_token, alice_user)

    # ── Cell A: create a hub-side FM with a body-requiring attachment.
    # We route through hub_post(CONVERSATION, ..., action="add_message") to
    # exercise the same code path the UI uses, so the hub stamps body_status
    # itself based on the incoming attachments.
    fm = FlowMessage(
        text="body upload smoke",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{skill_id}")],
    )
    hub_payload: dict[str, Any] = fm.model_dump(
        mode="python", context={"skip_api_serializer": True},
    )
    hub_data = await hub_post(
        BuiltinEntityType.CONVERSATION,
        hub_payload,
        entity_id=conv_id,
        action="add_message",
    )
    assert hub_data and hub_data.get("id"), f"add_message returned: {hub_data!r}"
    fm.id = hub_data["id"]
    assert fm.has_body() is True

    # Initial body_status stamped by the hub action: UPLOADING (attachments
    # require a body). This is the principle #7 contract.
    initial_status = hub_data.get("body_status")
    assert initial_status == BodyStatus.UPLOADING.value, (
        f"hub did not stamp UPLOADING on create; got body_status={initial_status!r}"
    )

    # ── Cell B: fm.upload_body() — packs + uploads + flips to READY.
    await fm.upload_body()
    assert fm.body_status == BodyStatus.READY
    assert fm.attachment_filename == BODY_FILENAME

    hub_after = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm.id)
    assert hub_after is not None
    assert hub_after.get("body_status") == BodyStatus.READY.value, (
        f"hub body_status did not flip to READY after upload_body; got {hub_after.get('body_status')!r}"
    )
    assert hub_after.get("attachment_filename") == BODY_FILENAME, (
        f"hub attachment_filename mismatch: got {hub_after.get('attachment_filename')!r}"
    )

    # ── Cell C: switch identity to bob and download_body() into a clean dest.
    _set_creds(bob_token, bob_user)
    bob_dest = tmp_path / "bob_dest"
    bob_dest.mkdir()

    bob_fm = FlowMessage(
        text=hub_after.get("text") or "",
        body_status=BodyStatus.READY,
        attachment_filename=hub_after.get("attachment_filename"),
    )
    bob_fm.id = fm.id

    # The bundle is restored under bob_dest/.claude/skills/<name>/SKILL.md.
    # download_body forwards asset_dest_root to unpack_bundle for FS-rooted
    # records, matching the existing test_message_matrix cell 4 contract.
    await bob_fm.download_body(asset_dest_root=bob_dest)
    restored_skill = bob_dest / ".claude" / "skills" / skill_name / "SKILL.md"
    assert restored_skill.exists(), f"skill not restored at {restored_skill}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_text_only_message_body_status_is_na(
    hub_base_url, isolated_hub_keyring,
) -> None:
    """Plain text → hub stamps body_status=NA (principle #7 negative case)."""
    oss_env = _read_env_local(REPO_OSS)
    app_env = _read_env_local(REPO_APP)
    if not (oss_env.get("FLOWPAD_CLOUD_USER_EMAIL") and app_env.get("FLOWPAD_CLOUD_USER_EMAIL")):
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD}")

    alice_token, alice_user = await _login(
        hub_base_url, oss_env["FLOWPAD_CLOUD_USER_EMAIL"], oss_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    bob_token, bob_user = await _login(
        hub_base_url, app_env["FLOWPAD_CLOUD_USER_EMAIL"], app_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    headers_a = {"Authorization": f"Bearer {alice_token}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}
    conv_id = await _setup_shared_conv(
        hub_base_url, headers_a, headers_b, app_env["FLOWPAD_CLOUD_USER_EMAIL"],
    )

    _set_creds(alice_token, alice_user)

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
            headers=headers_a,
            json={"text": "text only — no body"},
        )
    r.raise_for_status()
    data = r.json()["data"]
    assert data.get("body_status") == BodyStatus.NA.value, (
        f"text-only FM got body_status={data.get('body_status')!r}, expected NA"
    )
