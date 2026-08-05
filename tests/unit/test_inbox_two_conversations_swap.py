"""Two conversations must not trade places while their messages download.

Captured from a real inbox: the two top rows visibly swapped during a hub-switch
rebuild, right before the per-conversation message counters appeared — i.e. at the
moment the messages started landing. The fixture is those two conversations and
their nine messages, copied verbatim from the live DB (ids, both clocks, senders).

Inbox order is ``conversation.updated_date`` descending. The final answer is not in
question — A's newest message is 11:43:05 and B's is 09:38:33, so A belongs above B
and stays there. What this test pins is the PATH: a conversation is created from the
hub list before any of its messages exist, and only takes its real recency once the
first one lands. If the pre-message recency ranks the pair differently from the
post-message recency, the rows trade places exactly once — which is what a user
sees as a jump.

Asserting on the relative order at every step, not just at the end, is the whole
point: an end-state assertion passes on a sequence that flips in the middle.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root

FIXTURE = Path(__file__).parent.parent / "fixtures" / "inbox_swap_two_conversations.json"
A = "f69ce445"  # 'Integrate Supabase…'  — newest message 11:43:05, belongs on top
B = "d813eec8"  # 'Explain Z Campus…'    — newest message 09:38:33


@pytest.fixture()
def records_root(tmp_path, monkeypatch):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path / "data",
    )
    yield
    set_default_records_root(original)


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text())


def _hub_conv(c: dict) -> dict:
    """The conversation as the hub's list endpoint reports it — no messages yet."""
    return {
        "id": c["id"],
        "title": c["title"],
        "created_date": c["created_date"],
        "updated_date": c["updated_date"],
        "participants": [],
    }


async def _rank() -> tuple[str, str | None, str | None]:
    """Which of the two sorts first, plus both recencies."""
    convs = {c.id[:8]: c for c in await Conversation.get_all({}) if c.id and c.id[:8] in (A, B)}
    a, b = convs.get(A), convs.get(B)
    ra = Conversation._as_datetime(a.updated_date) if a else None
    rb = Conversation._as_datetime(b.updated_date) if b else None
    if ra is None or rb is None:
        return ("incomplete", str(ra), str(rb))
    return ("A_above_B" if ra > rb else "B_above_A", str(ra), str(rb))


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_two_conversations_never_trade_places_while_messages_arrive(records_root):
    from flow_sdk.app.actions.flow_message_action import _upsert_hub_conversation_metadata
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

    fx = _fixture()
    convs = {c["id"][:8]: c for c in fx["conversations"]}
    timeline: list[tuple[str, str, str, str]] = []

    # 1. Both conversations arrive from the hub list, message-less — exactly the
    #    order the sweep upserts them in.
    for key in (A, B):
        await _upsert_hub_conversation_metadata(_hub_conv(convs[key]), None, existing=None)
    rank, ra, rb = await _rank()
    timeline.append(("both conversations created, no messages", rank, ra, rb))

    # 2. Messages land newest-first, per conversation — the production fetch order.
    for key in (A, B):
        conv_id = convs[key]["id"]
        msgs = [m for m in fx["messages"] if m["conversation_id"] == conv_id]
        msgs.sort(key=lambda m: m["created_date"], reverse=True)
        for m in msgs:
            await materialize_flow_message(
                {
                    "id": m["id"],
                    "text": m["text"],
                    "conversation_id": conv_id,
                    "sender_name": m["sender_name"],
                    "sender_id": m["sender_id"],
                    "created_date": m["created_date"],
                    "updated_date": m["updated_date"],
                },
                conversation_id=conv_id,
                someone_typeid=None,
                bundle_ts=m["created_date"],
                remote=True,
                notify=False,
            )
            rank, ra, rb = await _rank()
            timeline.append((f"{key} +msg {m['id'][:8]} ({m['sender_name']})", rank, ra, rb))

    print("\n--- inbox order at every step ---")
    for label, rank, ra, rb in timeline:
        print(f"  {rank:<12} A={ra[:23] if ra else ra}  B={rb[:23] if rb else rb}   {label}")

    ranks = [r for _, r, _, _ in timeline if r != "incomplete"]
    flips = [(timeline[i][0], ranks[i - 1], ranks[i]) for i in range(1, len(ranks)) if ranks[i] != ranks[i - 1]]

    assert ranks[-1] == "A_above_B", f"final order wrong: {ranks[-1]}"
    assert not flips, (
        "the two conversations traded places while their messages downloaded — "
        f"{len(flips)} flip(s): " + "; ".join(f"at [{w}] {a} -> {b}" for w, a, b in flips)
    )
