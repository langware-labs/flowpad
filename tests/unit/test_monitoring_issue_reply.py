"""A Monitoring message carries its Issue (``metadata.issue``) and the hub keeps that one message current.

The hub writes ONE FlowMessage per Issue in a project's Monitoring conversation and UPDATES it as the issue
recurs or changes status. The desktop must derive ``issue_reply`` on arrival and apply an UPDATE's issue (and
text) onto the local row; nothing else about an UPDATE's text may change other messages.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import ConversationKind
from flow_sdk.builtin.flow_message import FlowMessage, derive_issue_reply
from flow_sdk.cloud_client.hub_bridge import HubWsBridge

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


class _NoHub:
    def send(self, *_a, **_kw):
        pass


def _issue(**over) -> dict:
    return {
        "issue_typeid": f"issue-{uuid.uuid4()}",
        "kind": "budget_exhausted",
        "severity": "error",
        "status": "open",
        "count": 1,
        "title": "Token limit reached",
        "detail": "The invite box used its whole budget.",
        "fix": {"label": "Refill", "pointer": "/dock/hub/budgets"},
        "subject_typeid": f"deployment-{uuid.uuid4()}",
        **over,
    }


def test_monitoring_kind_matches_the_hub():
    assert ConversationKind.MONITORING.value == "monitoring"


def test_issue_reply_rides_the_hub_metadata():
    issue = _issue()
    fm = FlowMessage.model_validate({"text": "Token limit reached"})
    derive_issue_reply(fm, {"metadata": {"issue": issue}})
    assert fm.issue_reply == issue
    derive_issue_reply(fm, {"text": "no metadata"})  # a refresh without it keeps what arrived
    assert fm.issue_reply == issue
    other = FlowMessage.model_validate({"text": "hi"})
    derive_issue_reply(other, {"metadata": {"issue": {"title": "no typeid"}}})
    assert other.issue_reply is None


async def _saved(text: str, issue: dict | None) -> FlowMessage:
    fm = FlowMessage.model_validate(
        {
            "conversation_id": str(uuid.uuid4()),
            "text": text,
            "sender_id": "hub",
            "remote": True,
            "issue_reply": issue,
        }
    )
    fm.id = str(uuid.uuid4())
    await fm.save(None, notify=False)
    return fm


@pytest.mark.asyncio
async def test_an_update_carries_the_issue_status_and_text_onto_the_message():
    issue = _issue()
    fm = await _saved("Token limit reached", issue)
    updated = {**issue, "status": "in_progress", "count": 3}

    await HubWsBridge(_NoHub())._handle_flow_message_op(
        "update", fm.id, {"text": "Token limit reached (3 times)", "metadata": {"issue": updated}}, fm.conversation_id
    )

    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.issue_reply == updated
    assert stored.text == "Token limit reached (3 times)"


@pytest.mark.asyncio
async def test_an_update_without_an_issue_never_rewrites_text():
    fm = await _saved("what the sender wrote", None)

    await HubWsBridge(_NoHub())._handle_flow_message_op(
        "update", fm.id, {"text": "something else", "received_at": "2026-11-11T00:00:00Z"}, fm.conversation_id
    )

    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.text == "what the sender wrote"
    assert stored.issue_reply is None
