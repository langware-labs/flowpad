"""Failure modes the routing suite does not cover: a hub too slow to answer, and a hub 5xx on a
write — through the real desktop server, against the real echo hub."""

from __future__ import annotations

import httpx
import pytest

REFLECT = {"Hub-Reflect": "true"}


@pytest.fixture
def short_forward_timeout(monkeypatch):
    from flow_sdk.cloud_client import hub_proxy

    monkeypatch.setattr(hub_proxy, "FORWARD_TIMEOUT", httpx.Timeout(1.0))


async def test_a_hub_too_slow_to_answer_is_a_502_not_a_hang(desktop, echo_hub, short_forward_timeout):
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.post(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "x-echo-mode": "slow", "x-echo-delay": "5"},
            json={},
        )
    assert r.status_code == 502, r.text
    assert r.json()["status"] == "FAIL"


@pytest.mark.parametrize("status", [500, 502, 503])
async def test_a_hub_failure_on_a_write_is_sent_once_and_returned_as_is(desktop, echo_hub, status):
    async with httpx.AsyncClient(base_url=desktop, timeout=30) as c:
        r = await c.post(
            "/api/v1/graph/invitation/pending",
            headers={**REFLECT, "x-echo-status": str(status)},
            json={"n": 1},
        )
    assert r.status_code == status
    assert r.json()["status"] == "FAIL"
    writes = [rec for rec in echo_hub.received if rec.method == "POST"]
    assert len(writes) == 1, f"a failed write was retried: {len(writes)} sends"


# ── conversation-list sync: prune on absence only after a COMPLETE walk ─────────────────────

CONVERSATIONS = "/api/v1/graph/conversation"


def _hub_conversations(n: int) -> list[dict]:
    import uuid
    from datetime import datetime, timedelta, timezone

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = []
    for i in range(n):
        stamp = (base + timedelta(seconds=i)).isoformat()
        rows.append(
            {"id": str(uuid.uuid4()), "type": "conversation", "title": f"hub conv {i}", "kind": "direct",
             "created_date": stamp, "updated_date": stamp}  # fmt: skip
        )
    return rows


async def _held_remote_conversation():
    import uuid

    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(id=str(uuid.uuid4()), title="held here, absent from the hub's pages")
    conv.remote = True
    await conv.save(notify=False)
    return conv


async def _conversation_list():
    from flow_sdk.app.actions.flow_message_action import handle_conversation_list
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    return (await handle_conversation_list((await get_or_create_local_user()).typeid)).data


@pytest.fixture
def no_invitations(echo_hub):
    echo_hub.scripted[("GET", "/api/v1/graph/invitation/pending")] = []
    return echo_hub


@pytest.mark.long
async def test_a_conversation_list_cut_short_prunes_nothing(desktop, no_invitations):
    from flow_sdk.builtin.conversation import Conversation

    echo_hub = no_invitations
    held = await _held_remote_conversation()
    echo_hub.paged[CONVERSATIONS] = _hub_conversations(210)
    echo_hub.paged_fail_at[CONVERSATIONS] = 200  # the second page fails

    data = await _conversation_list()
    assert data["pruned_ids"] == []
    assert await Conversation.get_by_id(held.id) is not None, "a partial walk pruned a row it never saw"
    # The first page's rows were still taken in.
    assert await Conversation.get_by_id(echo_hub.paged[CONVERSATIONS][0]["id"]) is not None

    del echo_hub.paged_fail_at[CONVERSATIONS]
    data = await _conversation_list()
    assert held.id in data["pruned_ids"]
    assert await Conversation.get_by_id(held.id) is None
    assert await Conversation.get_by_id(echo_hub.paged[CONVERSATIONS][-1]["id"]) is not None


@pytest.fixture
def short_page_timeout(monkeypatch):
    from flow_sdk.cloud_client import hub_proxy

    monkeypatch.setattr(hub_proxy, "DEFAULT_TIMEOUT", httpx.Timeout(1.0))


@pytest.mark.long
async def test_a_hub_too_slow_for_the_conversation_list_answers_local_and_prunes_nothing(
    desktop, no_invitations, short_page_timeout
):
    from flow_sdk.builtin.conversation import Conversation

    echo_hub = no_invitations
    held = await _held_remote_conversation()
    echo_hub.paged[CONVERSATIONS] = []
    echo_hub.paged_delay = 2.0  # past the (shortened) per-page budget

    data = await _conversation_list()
    assert data["hub_reachable"] is False
    assert data["pruned_ids"] == []
    assert held.id in {c["id"] for c in data["conversations"]}
    assert await Conversation.get_by_id(held.id) is not None
