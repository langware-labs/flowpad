"""Asking for help must never fail — the backend legs, against the real local hub.

Both help channels end in the same two hub writes: a support ticket
(``helpdesk-start-ticket`` → ``start_guest_conversation``) and a message into a shared
conversation (the Vibe "Ask someone for help" dialog → ``add_message``). Each test below
breaks ONE hub call at the network boundary — ``httpx.AsyncClient.send``, which every hub
HTTP call goes through — and asserts what "never fails" has to mean for that break: the
request the user typed is kept, and it reaches the hub once the hub is back, exactly once.

"Once the hub is back" is the recovery the app already has: ``run_hub_catchup``, which the
backend runs on startup and on login. A request that only a user retyping it can recover
is lost.

Identities: this instance is the requester (``hub_session``); ``bob_token`` is the helper
— the desk owner, or the person asked.
"""

from __future__ import annotations

import asyncio
import re
import sqlite3
import uuid
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(60)]  # do not increase timeout without approval

#: How long the hub is given to show a delivered row, polled. Well inside the cap so the
#: readable assertion fails, not the timeout kill.
DEADLINE_SECONDS = 15.0


# ---------------------------------------------------------------------------
# A hub that fails on purpose, at the network boundary
# ---------------------------------------------------------------------------


@dataclass
class _Rule:
    method: str
    path: re.Pattern
    answer: str  # "down" (connection refused) | "502" (a load balancer's HTML page)
    hits: int = 0


class HubFaults:
    """Break chosen hub requests; everything else reaches the real hub."""

    def __init__(self) -> None:
        self.rules: list[_Rule] = []

    def fail(self, method: str, path: str, answer: str = "down") -> _Rule:
        rule = _Rule(method.upper(), re.compile(path), answer)
        self.rules.append(rule)
        return rule

    def heal(self) -> None:
        self.rules.clear()

    def answer(self, request: httpx.Request) -> httpx.Response | None:
        for rule in self.rules:
            if request.method == rule.method and rule.path.search(request.url.path):
                rule.hits += 1
                if rule.answer == "502":
                    return httpx.Response(502, text="<html><body>502 Bad Gateway</body></html>", request=request)
                raise httpx.ConnectError("injected: hub unreachable", request=request)
        return None


@pytest.fixture
def hub_faults(monkeypatch) -> HubFaults:
    faults = HubFaults()
    real_send = httpx.AsyncClient.send

    async def send(self, request, *args, **kwargs):
        injected = faults.answer(request)
        if injected is not None:
            return injected
        return await real_send(self, request, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    return faults


# ---------------------------------------------------------------------------
# Hub reads — ground truth is the hub's own rows, never a local projection
# ---------------------------------------------------------------------------


async def _hub(base: str, token: str, method: str, path: str, json: Any = None) -> Any:
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.request(method, f"{base}/api/v1{path}", headers={"Authorization": f"Bearer {token}"}, json=json)
    assert r.status_code == 200, f"{method} {path}: {r.text[:200]}"
    return r.json().get("data")


async def _eventually(probe, *, deadline: float = DEADLINE_SECONDS):
    """``probe()`` until it returns something truthy, or its last value at the deadline."""
    end = asyncio.get_event_loop().time() + deadline
    while True:
        value = await probe()
        if value or asyncio.get_event_loop().time() >= end:
            return value
        await asyncio.sleep(0.5)


def _ok(response) -> bool:
    return getattr(response.status, "value", response.status) == "SUCCESS"


async def _recover() -> None:
    """What the app does when the hub comes back: the startup / login catch-up."""
    from flow_sdk.stream_inbox.catchup import run_hub_catchup

    await run_hub_catchup("test: hub is back")


# ---------------------------------------------------------------------------
# Ask someone for help (Vibe): the message into the shared conversation
# ---------------------------------------------------------------------------


@pytest.fixture
def task_storage(tmp_path):
    """Somewhere for a task's folder to live — the server gives a request one."""
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


@pytest.fixture
async def help_conversation(hub_session, task_storage):
    """The conversation the Vibe dialog creates: shared with the helper, holding a task chip."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.task import Task
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests.conftest import _resolve_identities

    someone = (await get_or_create_local_user()).typeid
    _, helper_email = _resolve_identities()
    task = Task(title=f"help me {uuid.uuid4().hex[:8]}", description="the build fails")
    await task.save(someone)
    conv = Conversation(title=task.title)
    await conv.save(someone)
    await conv.share(recipients=[helper_email])
    assert conv.remote is True, "precondition: the conversation must be hub-backed before the message"
    # The share ACTION persists `remote` (share_entity); `Entity.share()` alone sets it in memory.
    await conv.save(someone)
    return SimpleNamespace(conv=conv, task=task, someone=someone)


async def _ask(conv, task, someone, text: str):
    from flow_sdk.app.actions.notification_action import handle_add_message

    return await handle_add_message(
        {
            "conversation_id": conv.id,
            "text": text,
            "asset_references": [str(task.typeid)],
            "shared_context_entities": [str(task.typeid)],
        },
        someone,
    )


async def test_a_help_message_whose_hub_push_failed_reaches_the_helper_once_the_hub_is_back(
    hub_session, hub_faults, help_conversation
):
    """The hub drops the message header. The send says SUCCESS; the message is marked neither
    sent nor queued, so the outbox (``pending_send`` only) never picks it up again."""
    base, token = hub_session["base_url"], hub_session["api_key"]
    conv, task, someone = help_conversation.conv, help_conversation.task, help_conversation.someone
    text = f"please help {uuid.uuid4().hex[:8]}"

    rule = hub_faults.fail("POST", rf"/conversation/{conv.id}/add_message$")
    response = await _ask(conv, task, someone, text)
    assert rule.hits, "precondition: the injected hub failure must have been hit"

    hub_faults.heal()
    await _recover()

    async def on_hub():
        rows = await _hub(base, token, "GET", f"/graph/conversation/{conv.id}/flow_message") or []
        return [m for m in rows if (m.get("text") or "").strip() == text]

    delivered = await _eventually(on_hub)
    assert len(delivered) == 1, (
        f"the helper never got the request: the send answered {getattr(response.status, 'value', response.status)!r} while the hub "
        f"push failed, and nothing retried it after the hub came back (hub rows: {len(delivered)})"
    )


async def test_a_help_message_whose_attachments_failed_to_upload_opens_for_the_helper_after_a_restart(
    hub_session, hub_faults, help_conversation
):
    """The header lands, the body bundle (the task, screenshots, transcript) does not. The upload
    is a fire-and-forget task: one failure leaves the hub row UPLOADING for good — the helper
    sees a message whose attachments never open. A backend restart loses the task the same way."""
    from flow_sdk.builtin.flow_message import FlowMessage

    base, token = hub_session["base_url"], hub_session["api_key"]
    conv, task, someone = help_conversation.conv, help_conversation.task, help_conversation.someone
    text = f"see attached {uuid.uuid4().hex[:8]}"

    rule = hub_faults.fail("POST", r"/flow_message/[^/]+/fs/upload$")
    response = await _ask(conv, task, someone, text)
    fm_id = (response.data or {}).get("id")
    assert fm_id, f"precondition: the send must have produced a message, got {response}"

    async def upload_attempted():
        local = await FlowMessage.get_one({"id": fm_id})
        return rule.hits and local is not None

    assert await _eventually(upload_attempted), "precondition: the body upload must have been tried and failed"
    await asyncio.sleep(1.0)  # let the failed background upload unwind

    hub_faults.heal()
    await _recover()

    async def body_ready():
        row = await _hub(base, token, "GET", f"/graph/flow_message/{fm_id}") or {}
        return (row.get("body_status") or "") == "ready" and row

    row = await _eventually(body_ready)
    assert row, (
        "the helper's copy of the request never became openable: the hub row stayed "
        "body_status=uploading after the upload failed once, and nothing re-uploads it"
    )


# ---------------------------------------------------------------------------
# Help desk: the support ticket
# ---------------------------------------------------------------------------


@pytest.fixture
async def desk(hub_base_url, bob_token):
    """A desk the HELPER owns, so this instance is a real guest of it. Deleted after."""
    async with httpx.AsyncClient(timeout=20) as h:
        auth = {"Authorization": f"Bearer {bob_token}"}
        r = await h.post(f"{hub_base_url}/api/v1/graph/project", headers=auth, json={"name": f"desk-{uuid.uuid4().hex[:8]}"})
        assert r.status_code == 200, r.text
        desk_id = r.json()["data"]["id"]
        on = await h.post(
            f"{hub_base_url}/api/v1/graph/project/{desk_id}/enable_helpdesk",
            headers=auth,
            json={"enabled": True, "display_name": "Test Support", "mode": "human"},
        )
        assert on.status_code == 200, on.text
    try:
        yield desk_id
    finally:
        async with httpx.AsyncClient(timeout=20) as h:
            gone = await h.request(
                "DELETE", f"{hub_base_url}/api/v1/graph/project/{desk_id}", headers={"Authorization": f"Bearer {bob_token}"}, json={}
            )
        assert gone.status_code < 400, f"LEAKED desk project {desk_id}: {gone.text[:200]}"


async def _open_ticket(desk_id: str, text: str):
    """``helpdesk-start-ticket`` exactly as the dialog calls it; routing pinned to ``desk_id``."""
    from flow_sdk.app.actions import flow_message_action as fma
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    someone = (await get_or_create_local_user()).typeid
    request = SimpleNamespace(someone_typeid=someone, get_post_data=AsyncMock(return_value={"text": text, "project_id": ""}))
    with (
        patch.object(fma, "get_current_request_info", return_value=request),
        patch.object(fma, "resolve_helpdesk", AsyncMock(return_value=fma.HelpdeskTarget(desk_id))),
    ):
        return await fma.helpdesk_start_ticket()


async def _tickets_with(base: str, desk_owner_token: str, desk_id: str, text: str) -> list[dict]:
    """The desk's tickets whose opening line is ``text`` — what the helper actually sees."""
    pool = await _hub(base, desk_owner_token, "GET", f"/graph/project/{desk_id}/helpdesk_conversations") or []
    out = []
    for ticket in pool:
        conv_id = ticket.get("conversation_id") or ticket.get("id")
        rows = await _hub(base, desk_owner_token, "GET", f"/graph/conversation/{conv_id}/flow_message") or []
        if any((m.get("text") or "").strip().startswith(text) for m in rows):
            out.append(ticket)
    return out


async def test_a_ticket_typed_while_the_hub_is_down_is_kept_and_reaches_the_desk(
    hub_session, hub_faults, bob_token, desk
):
    """Hub down at Send: the action answers 502 and nothing is stored — the text the user typed
    exists only in a dialog they are about to close."""
    from flow_sdk.builtin.conversation import Conversation

    base = hub_session["base_url"]
    text = f"cannot log in {uuid.uuid4().hex[:8]}"

    rule = hub_faults.fail("POST", rf"/project/{desk}/start_guest_conversation$")
    response = await _open_ticket(desk, text)
    assert rule.hits, "precondition: the injected hub failure must have been hit"

    conv_id = (response.data or {}).get("conversation_id") if _ok(response) else None
    kept = conv_id and await Conversation.get_one({"id": conv_id})
    assert kept, (
        f"the request was lost: with the hub down the ticket action answered {response.status} "
        f"({response.message!r}) and kept nothing locally to send later"
    )

    hub_faults.heal()
    await _recover()
    assert await _eventually(lambda: _tickets_with(base, bob_token, desk, text)), (
        "the kept request never reached the desk after the hub came back"
    )


async def test_a_ticket_the_hub_accepted_is_reported_open_even_if_the_local_copy_fails(
    hub_session, bob_token, desk
):
    """The hub creates the ticket; then the first local write hits a local error (``database is
    locked`` — a real, recurring one here). Nothing after the hub call is guarded, so the user is
    told the ticket FAILED while the desk has it. They resend: two tickets."""
    base = hub_session["base_url"]
    text = f"my agent is stuck {uuid.uuid4().hex[:8]}"

    locked = AsyncMock(side_effect=sqlite3.OperationalError("database is locked"))
    with patch("flow_sdk.app.actions.materialize_flow_message.ensure_conversation_entity", locked):
        response = await _open_ticket(desk, text)

    on_desk = await _eventually(lambda: _tickets_with(base, bob_token, desk, text))
    assert on_desk, "precondition: the hub must have accepted the ticket"
    assert _ok(response), (
        f"the desk HAS the ticket, but the requester was told {response.message!r} — "
        "a resend from them opens a duplicate"
    )


async def test_the_requester_sees_their_own_opening_line_after_one_failed_local_write(hub_session, desk):
    """One transient local failure while copying the ticket's first message (the guest's own
    words): the action logs "opening line not found", stalls, and answers SUCCESS — the requester
    opens their ticket and it does not contain what they wrote."""
    from flow_sdk.app.actions import flow_message_action as fma
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.db.drivers.query import QueryFilter

    text = f"the deploy hangs {uuid.uuid4().hex[:8]}"
    real = fma._process_single_hub_message
    calls = {"n": 0}

    async def locked_once(raw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return await real(raw)

    with patch.object(fma, "_process_single_hub_message", locked_once):
        response = await _open_ticket(desk, text)
    assert _ok(response), f"precondition: the ticket must open, got {response.message!r}"
    assert calls["n"], "precondition: the injected local failure must have been hit"

    conv_id = response.data["conversation_id"]
    mine = await FlowMessage.get_all(QueryFilter(match={"conversation_id": conv_id}), hydrate=False)
    assert any(text in (m.text or "") for m in mine), (
        f"the requester's ticket {conv_id[:8]} holds {len(mine)} message(s) and none is the request "
        "they typed — one failed local write lost it for good"
    )


@pytest.mark.parametrize(
    "break_it, expected",
    [
        pytest.param("502", "502", id="load-balancer-502"),
        pytest.param("signed-out", "sign in", id="signed-out"),
    ],
)
async def test_a_failed_ticket_says_why(hub_session, hub_faults, desk, break_it, expected, monkeypatch):
    """Every hub failure collapses into ``hub unreachable``: a 502 page, a signed-out backend and
    a dead network all read the same, so neither the user nor support can tell them apart."""
    text = f"why did it fail {uuid.uuid4().hex[:8]}"
    if break_it == "502":
        hub_faults.fail("POST", rf"/project/{desk}/start_guest_conversation$", answer="502")
    else:
        monkeypatch.setattr("flow_sdk.cli.auth.credentials.load_credentials", lambda *a, **k: None)

    response = await _open_ticket(desk, text)
    assert not _ok(response), "precondition: this break must fail the send"
    assert expected in (response.message or "").lower(), (
        f"the failure is reported as {response.message!r} — it does not say {expected!r}"
    )
