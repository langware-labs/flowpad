"""A support ticket, end to end, with the real support agent and three real users.

The customer asks for help; the agent acknowledges once and hands the request to the team as a guest message, which
the hub screens into the ticket's team conversation; nothing of the team side reaches the customer.

It needs more than the hub tier gives: a real ``claude`` turn that runs ``flow`` commands, so the
agent must run on a live instance. Point it at one with the variables below and it drives the rest
over HTTP; without them it skips. Run it as the product is: the agent's project as committed (no row
patched by hand, its trigger's ``if`` intact), on a hub that has a decision API.

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


def customer_name(messages: list[dict]) -> str:
    """The opener's name as the hub shows it: the sender of the ticket's first message."""
    return messages[0].get("sender_name", "")


def _until(what: str, found: Callable[[], Any]) -> Any:
    deadline = time.monotonic() + STEP_SECONDS
    while time.monotonic() < deadline:
        if value := found():
            return value
        time.sleep(3)
    raise AssertionError(f"no {what} within {STEP_SECONDS}s")


def _team_conversation(hub: str, team: dict, ticket: str) -> Optional[str]:
    """The ticket's team conversation, once the desk opened it (on the support agent's first guest message)."""
    answer = httpx.get(f"{hub}/api/v1/graph/conversation/{ticket}/team_conversation", headers=team, timeout=15)
    if answer.status_code != 200:
        return None
    return str((answer.json().get("data") or {}).get("id") or "") or None


@pytest.mark.skipif(
    not all(os.environ.get(f"SUPPORT_E2E_{name}") for name in NAMES),
    reason="needs a live support agent (see the module)",
)
def test_a_customer_is_acknowledged_and_the_team_gets_a_screened_guest_message(hub_base_url):
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

    # The agent hands the request to the team as a guest message: the desk opens the team conversation, which holds
    # its screened reference.
    private = _until("team conversation", lambda: _team_conversation(hub, team, ticket))
    reference = _until(
        "guest message",
        lambda: [m for m in _messages(hub, team, private) if (m.get("metadata") or {}).get("guest_message")],
    )
    assert reference[0]["metadata"]["guest_message"]["status"] in ("pending", "passed", "held"), reference[0]

    # The customer holds their own messages and ONE acknowledgement: the team's side writes them nothing.
    after = _messages(hub, customer, ticket)
    desk = [m for m in after if m.get("sender_name") != customer_name(after)]
    assert len(desk) == 1, f"one acknowledgement, not {len(desk)}: {[m['text'][:60] for m in desk]}"
    assert desk[0]["sender_name"] != _setting("TEAM_EMAIL"), "the customer sees the desk, never the team member"
