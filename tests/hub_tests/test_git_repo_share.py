"""Hub e2e: share a ``GitRepo`` entity via a conversation message.

Reuses the alice/bob fixture pattern from ``test_share_with_recipients.py``.
Validates the wire contract:

1. Alice creates a fresh ``GitRepo`` locally (the same path
   ``repo/materialize`` follows on the local server).
2. Alice shares the conversation with bob, then sends a message with the
   ``GitRepo`` attached via the standard ``shared_context_entities`` /
   ``asset_references`` path.
3. Bob receives the message; the attachment carries a ``git_repo-<id>``
   TypeId; bob can fetch the GitRepo entity from the hub by that id.

If the hub doesn't yet expose ``GET /api/v1/graph/git_repo/<id>`` the
fetch step skips with a clear message rather than failing the suite.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import httpx
import pytest


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


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_git_repo_share_carries_typeid_to_recipient(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.git_repo import GitRepo

    alice_token = hub_login_payload.get("api_key") or hub_login_payload["token"]
    alice_user = hub_login_payload.get("user") or {}
    save_credentials(UserHubCredentials(api_key=alice_token, user=alice_user))

    app_env = _read_env_local(REPO_APP)
    bob_email = app_env.get("FLOWPAD_CLOUD_USER_EMAIL")
    bob_pw = app_env.get("FLOWPAD_CLOUD_USER_PASSWORD")
    if not bob_email or not bob_pw:
        pytest.skip("missing FLOWPAD_CLOUD_USER_{EMAIL,PASSWORD} in flowpad-app/.env.local")

    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.post(f"{hub_base_url}/api/v1/login", json={"email": bob_email, "password": bob_pw})
        r.raise_for_status()
        bob_data = r.json()["data"]
        bob_token = bob_data.get("api_key") or bob_data["token"]

    # Materialize the GitRepo the same way ``repo/materialize`` does on the
    # local server — fresh uuid4 id, non-secret RepoSummary-shaped fields.
    git_repo = GitRepo(
        provider="github",
        owner="langware-labs",
        name="flowpad",
        full_name="langware-labs/flowpad",
        branch="main",
        default_branch="main",
        html_url="https://github.com/langware-labs/flowpad",
        private=False,
    )
    await git_repo.save()
    git_repo_typeid_str = f"{git_repo.type}-{git_repo.id}"

    title = f"git-repo-share-{int(time.time())}"
    conv = Conversation(title=title)
    await conv.share(recipients=[bob_email])
    assert conv.remote is True

    # Bob accepts + joins via the canonical chain.
    headers_b = {"Authorization": f"Bearer {bob_token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/invitation/pending", headers=headers_b)
        r.raise_for_status()
        pending = r.json()["data"] or []
        matching = [inv for inv in pending if inv.get("recipient_email") == bob_email and not inv.get("accepted")]
        assert matching, f"bob has no pending invitation; got {pending}"
        matching.sort(key=lambda x: x.get("created_date") or "", reverse=True)
        invitation_id = matching[0]["id"]
        # members/accept is browser-oriented and ALWAYS 302s (→login = accept
        # did NOT run; →/conversation|/flow_message = success, role granted
        # server-side). Mirror the SDK's handle_invitation_accept: do NOT
        # follow; 200/409 or a conversation/flow_message redirect = success,
        # login redirect = failure. (raise_for_status rejected the by-design
        # 302.)
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/members/accept",
            headers=headers_b,
            params={"invitation-id": invitation_id},
        )
        if r.status_code not in (200, 409):
            if r.status_code in (301, 302, 303, 307, 308):
                location = (r.headers.get("location") or r.headers.get("Location") or "")
                assert "login" not in location.lower(), (
                    f"accept redirected to login (unauthenticated); location={location[:200]}"
                )
                assert ("/conversation/" in location) or ("/flow_message/" in location), (
                    f"accept returned an unexpected redirect location={location[:200]}"
                )
            else:
                r.raise_for_status()
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers=headers_b,
            json={},
        )
        r.raise_for_status()

    # Alice sends a message with the GitRepo TypeId in shared_context_entities.
    # The hub expects a list of {type, id} dicts (see tests/unit/
    # test_flow_message_roundtrip.py:40 for the canonical example).
    # TYPE_ID attachment is the standard sender→recipient channel for
    # asset references (same as Markdown/Spec — see notification_action.py:214).
    fm = await conv.add_message(
        text=f"Working on {git_repo.full_name}",
        attachments=[
            {"attachment_type": "type_id", "data": git_repo_typeid_str}
        ],
    )
    assert fm is not None
    fm_id = fm.get("id") if isinstance(fm, dict) else getattr(fm, "id", None)
    assert fm_id, f"add_message returned no id: {fm}"

    # Bob fetches the FlowMessage and asserts the attachment is present.
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/flow_message/{fm_id}", headers=headers_b)
        assert r.status_code == 200, r.text
        bob_fm = r.json()["data"]
        # The TypeId rides in shared_context_entities OR attachment.data for
        # type_id attachments — different hub versions place it in different
        # fields. Accept either.
        shared = bob_fm.get("shared_context_entities") or []
        # shared entries can be either bare ``"<type>-<id>"`` strings OR
        # ``{type, id}`` dicts depending on the hub version — normalize.
        def _shared_to_str(s):
            if isinstance(s, str):
                return s
            if isinstance(s, dict) and s.get("type") and s.get("id"):
                return f"{s['type']}-{s['id']}"
            return None
        shared_strs = [_shared_to_str(s) for s in shared]
        attachments = bob_fm.get("attachment") or []
        attachment_typeids = [
            a.get("data") for a in attachments
            if isinstance(a, dict) and a.get("attachment_type") == "type_id"
        ]
        all_typeids = [s for s in shared_strs if s] + attachment_typeids
        assert git_repo_typeid_str in all_typeids, (
            f"GitRepo TypeId {git_repo_typeid_str} not found in bob's FlowMessage; "
            f"shared={shared} attachments={attachment_typeids}"
        )

    # Optional: bob fetches the GitRepo entity by id. If the hub hasn't
    # implemented git_repo storage yet (the entity is new), this 404s —
    # skip with a clear message rather than fail.
    async with httpx.AsyncClient(timeout=5.0) as h:
        r = await h.get(f"{hub_base_url}/api/v1/graph/git_repo/{git_repo.id}", headers=headers_b)
        # 404 = entity not found; 422 = hub doesn't know the type. Either
        # signals "hub doesn't store git_repo entities yet" — skip with a
        # clear message rather than fail this PR's tests.
        if r.status_code in (404, 422):
            pytest.skip(
                f"Hub does not yet store git_repo entities ({r.status_code}: "
                f"{r.text[:120]}). The TypeId rides in the FlowMessage "
                "attachment but the entity itself is local-only on bob's "
                "side until bob materializes it. Out-of-tree hub work."
            )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data.get("full_name") == git_repo.full_name
        assert data.get("branch") == git_repo.branch
