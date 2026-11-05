"""A support ticket, end to end, with the real support agent and three real users.

The customer asks for help; the agent acknowledges and consults the team in a private
``[ticket <id>]`` conversation; nothing reaches the customer until a team member approves; then
the approved answer does.

It needs more than the hub tier gives: a real ``claude`` turn that runs ``flow`` commands, so the
agent must run on a live instance. Point it at one with the variables below and it drives the rest
over HTTP; without them it skips.

    SUPPORT_E2E_CUSTOMER_BACKEND  the customer instance's backend URL
    SUPPORT_E2E_CUSTOMER_EMAIL / _PW
    SUPPORT_E2E_TEAM_EMAIL / _PW  listed in the agent's SUPPORT_TEAM_EMAILS
    SUPPORT_E2E_DESK              the desk (hub project id) the deployed agent's channel polls
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any, Callable, Optional

import httpx
import pytest

pytestmark = [pytest.mark.hub, pytest.mark.timeout(600)]  # a new long tier budget: three agent turns

NAMES = ("CUSTOMER_BACKEND", "CUSTOMER_EMAIL", "CUSTOMER_PW", "TEAM_EMAIL", "TEAM_PW", "DESK")
#: The agent polls the desk on a schedule and runs a real turn: this is what one step may take.
STEP_SECONDS = 240


def _setting(name: str) -> str:
    return os.environ[f"SUPPORT_E2E_{name}"]


def _bearer(hub: str, email: str, password: str) -> dict[str, str]:
    data = httpx.post(f"{hub}/api/v1/login", json={"email": email, "password": password}, timeout=10).json()["data"]
    return {"Authorization": f"Bearer {data.get('api_key') or data['token']}"}


def _messages(hub: str, auth: dict, conversation: str) -> list[dict]:
    answer = httpx.get(f"{hub}/api/v1/graph/conversation/{conversation}/messages", headers=auth, timeout=15)
    answer.raise_for_status()
    return answer.json()["data"]


def _until(what: str, found: Callable[[], Any]) -> Any:
    deadline = time.monotonic() + STEP_SECONDS
    while time.monotonic() < deadline:
        if value := found():
            return value
        time.sleep(3)
    raise AssertionError(f"no {what} within {STEP_SECONDS}s")


def _invitation_to(hub: str, team: dict, ticket: str) -> Optional[str]:
    """The team member's invitation to the ticket's private conversation."""
    pending = httpx.get(f"{hub}/api/v1/graph/invitation/pending", headers=team, timeout=15).json()["data"]
    return next((row for row in pending if ticket in str(row)), None)


@pytest.mark.skipif(
    not all(os.environ.get(f"SUPPORT_E2E_{name}") for name in NAMES),
    reason="needs a live support agent (see the module)",
)
def test_a_customer_gets_the_answer_the_team_approved(hub_base_url):
    hub = hub_base_url
    customer = _bearer(hub, _setting("CUSTOMER_EMAIL"), _setting("CUSTOMER_PW"))
    team = _bearer(hub, _setting("TEAM_EMAIL"), _setting("TEAM_PW"))
    ticket = str(uuid.uuid4())

    asked = httpx.post(
        f"{_setting('CUSTOMER_BACKEND')}/api/v1/graph/ask-for-help",
        json={
            "conversation_id": ticket,
            "recipient": {"kind": "desk", "desk_project_id": _setting("DESK")},
            "title": "I cannot connect",
            "text": "I cannot connect, I see the error hub unreachable",
            "origin": "top_bar",
            "diagnose": True,
        },
        timeout=60,
    ).json()
    assert asked["status"] == "SUCCESS", asked

    # The agent consults the team: an invitation, then the summary with its proposed answer.
    invitation = _until("invitation to the private conversation", lambda: _invitation_to(hub, team, ticket))
    accepted = httpx.get(
        f"{hub}/api/v1/graph/members/accept", params={"invitation-id": invitation["id"]}, headers=team, timeout=20
    )
    assert accepted.status_code in (200, 302), accepted.text
    private = invitation["entity_id"] if "entity_id" in invitation else invitation["target"]["id"]
    summary = _until("summary", lambda: _messages(hub, team, private))
    assert "approve" in summary[0]["text"].lower(), summary[0]["text"]

    # Until the team approves, the customer holds their own messages and acknowledgements only.
    before = _messages(hub, customer, ticket)
    assert len(before) >= 2, "the agent acknowledged the ticket"
    answered = httpx.post(
        f"{hub}/api/v1/graph/conversation/{private}/add_message",
        headers=team,
        json={"id": str(uuid.uuid4()), "text": "approve"},
        timeout=20,
    )
    assert answered.status_code == 200, answered.text

    after = _until(
        "answer to the customer", lambda: (m := _messages(hub, customer, ticket)) and len(m) > len(before) and m
    )
    answer = after[-1]
    assert answer["sender_name"] != _setting("TEAM_EMAIL"), "the customer sees the desk, never the team member"
    assert "[ticket" not in answer["text"], "nothing of the private conversation reaches the customer"
