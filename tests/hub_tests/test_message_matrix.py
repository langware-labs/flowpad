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
from flow_sdk.utils.hub import hub_get, hub_post


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


async def _bob_ws_collector(
    hub_base_url: str, bob_token: str, ready: asyncio.Event, events: asyncio.Queue,
) -> None:
    """Pump every WS frame into ``events`` so the test can wait for specific ids."""
    url = _make_ws_url(hub_base_url)
    headers = {"Authorization": f"Bearer {bob_token}"}
    async with websockets.connect(url, additional_headers=headers) as ws:
        ready.set()
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            await events.put(msg)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_matrix_http_ws_upload_download(
    tmp_path: Path, hub_base_url, isolated_hub_keyring,
) -> None:
    # ── Setup ───────────────────────────────────────────────────────────────
    alice_env = _read_env_local(REPO_OSS)
    bob_env = _read_env_local(REPO_APP)
    if not (alice_env.get("FLOWPAD_CLOUD_USER_EMAIL") and bob_env.get("FLOWPAD_CLOUD_USER_EMAIL")):
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-oss or flowpad-app .env.local")

    alice_token, alice_user = await _login(
        hub_base_url, alice_env["FLOWPAD_CLOUD_USER_EMAIL"], alice_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    bob_token, bob_user = await _login(
        hub_base_url, bob_env["FLOWPAD_CLOUD_USER_EMAIL"], bob_env["FLOWPAD_CLOUD_USER_PASSWORD"],
    )
    alice_id, bob_id = alice_user["id"], bob_user["id"]
    print(f"\nalice {alice_id[:8]}  bob {bob_id[:8]}")

    headers_a = {"Authorization": f"Bearer {alice_token}", "Content-Type": "application/json"}
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}

    conv_id = await _alice_setup_shared_conversation(
        hub_base_url, headers_a, headers_b, bob_env["FLOWPAD_CLOUD_USER_EMAIL"],
    )
    print(f"conv {conv_id[:8]} ready")

    # Open bob's WS *before* cell 1 so the create frame is captured.
    bob_events: asyncio.Queue = asyncio.Queue()
    bob_ready = asyncio.Event()
    bob_ws_task = asyncio.create_task(
        _bob_ws_collector(hub_base_url, bob_token, bob_ready, bob_events)
    )
    try:
        await asyncio.wait_for(bob_ready.wait(), timeout=5.0)
        await asyncio.sleep(0.1)  # tiny grace period after WS upgrade

        # ── Cell 1: HTTP send header ────────────────────────────────────────
        async with httpx.AsyncClient(timeout=5.0) as h:
            r = await h.post(
                f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/add_message",
                headers=headers_a, json={"text": "cell-1-http"},
            )
        r.raise_for_status()
        fm_http_id = r.json()["data"]["id"]
        assert fm_http_id, "add_message response missing flow_message id"
        print(f"cell 1 (HTTP send): fm={fm_http_id[:8]}")

        # ── Cell 2: WS receive header ───────────────────────────────────────
        ev = await _await_fm_create(bob_events, fm_http_id, timeout=5.0)
        ev_data = ev["data"] or {}
        assert ev_data.get("text") == "cell-1-http", f"WS data.text mismatch: {ev_data!r}"
        assert ev_data.get("sender_id") == alice_id, f"WS sender mismatch: {ev_data.get('sender_id')!r}"
        print("cell 2 (WS receive): payload matches sender + text")

        # Author skill+agent locally as alice (need real Record state for pack).
        src_root = tmp_path / "alice_src"
        skill_dir, agent_path = _write_skill_and_agent(src_root)
        await _build_local_indexer(src_root).index(IndexerOptions(verbose=False, force=True))
        skill_id = SkillRecord.load_record(skill_dir).id
        agent_id = Entity.allocate_id({"id": _AGENT_NAME, "type": str(RecordType.AGENT)})
        assert SkillRecord.get(skill_id) is not None
        assert AgentRecord.get(agent_id) is not None

        # ── Cell 3: upload body (separate hub FM + bundle) ─────────────────
        _set_creds(alice_token, alice_user)

        fm_bundle = FlowMessage(text="cell-3-bundle", attachment=[])
        fm_bundle.attachment = [
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"skill-{skill_id}"),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"agent-{agent_id}"),
        ]
        hub_payload: dict[str, Any] = fm_bundle.model_dump(
            mode="python", context={"skip_api_serializer": True},
        )
        hub_payload["context_entities"] = [f"conversation-{conv_id}"]
        hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, hub_payload)
        assert hub_data and hub_data.get("id"), f"hub_post(flow_message) returned: {hub_data!r}"
        hub_fm_id = hub_data["id"]
        fm_bundle.id = hub_fm_id  # align local & hub ids so pack carries the hub id

        # Pack + upload + stamp attachment_filename. Uses the standard helper
        # so we exercise the production path, not an inline duplicate.
        from flow_sdk.app.actions.notification_action import _upload_bundle_to_hub
        await _upload_bundle_to_hub(hub_fm_id, fm_bundle, task_title="matrix-cell-3")

        hub_fm_after = await hub_get(BuiltinEntityType.FLOW_MESSAGE, hub_fm_id)
        assert hub_fm_after, "hub_get returned no FM after upload"
        attachment_filename = (hub_fm_after.get("attachment_filename") or "").strip()
        assert attachment_filename, f"hub FM did not get stamped: {hub_fm_after!r}"
        print(f"cell 3 (upload): hub_fm={hub_fm_id[:8]} filename={attachment_filename}")

        # ── Cell 4: download body, unpack, reindex (bob side) ──────────────
        # Tear down alice's local skill/agent so bob's restore is visibly the
        # cause of records being back.
        import shutil as _shutil
        _shutil.rmtree(src_root / ".claude")
        await _clear_local_asset_state()
        assert SkillRecord.get(skill_id) is None
        assert AgentRecord.get(agent_id) is None

        _set_creds(bob_token, bob_user)

        bob_dest = tmp_path / "bob_dest"
        bob_dest.mkdir()

        from flow_sdk.app.actions.flow_message_action import _download_and_unpack_bundle
        success = await _download_and_unpack_bundle(
            hub_fm_id, attachment_filename, asset_dest_root=bob_dest,
        )
        assert success, "bob bundle download/unpack returned False"

        # Three layers should all be back.
        restored_skill = bob_dest / ".claude" / "skills" / _SKILL_NAME / "SKILL.md"
        restored_agent = bob_dest / ".claude" / "agents" / f"{_AGENT_NAME}.md"
        assert restored_skill.exists(), f"skill FS subtree not restored at {restored_skill}"
        assert restored_agent.exists(), f"agent FS file not restored at {restored_agent}"
        assert SkillRecord.get(skill_id) is not None, "skill not reindexed after unpack"
        assert AgentRecord.get(agent_id) is not None, "agent not reindexed after unpack"
        assert skill_id in await _fts_ids(_SKILL_DESCRIPTION), "skill missing from FTS after unpack"
        assert agent_id in await _fts_ids(_AGENT_DESCRIPTION), "agent missing from FTS after unpack"
        print("cell 4 (download+unpack+reindex): FS + Record + FTS all restored")
    finally:
        bob_ws_task.cancel()
        try:
            await bob_ws_task
        except (asyncio.CancelledError, Exception):
            pass
