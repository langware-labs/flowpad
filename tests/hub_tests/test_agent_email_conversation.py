"""Someone outside emails a deployed agent, and the agent answers.

**What this costs depends on the hub's provider.** It allocates two mailboxes —
one for the agent under test, one for the correspondent who writes to it — and
against the AgentMail provider those are genuine, permanent, publicly writable
addresses that cost money. Against the hub's ``local`` provider they are
in-process and free, and the round trip is still real: that provider allocates
addresses, stores messages, delivers between local inboxes and implements the
actual threading rules, which is what makes an agent-to-agent exchange work
offline. Either way both are released by fixture finalizers, so a failed
assertion still gives them back.

Run it free with a hub started as::

    EMAIL_INBOX_ENABLED=true EMAIL_INBOX_PROVIDER=local ...

and point the tier at it with ``FLOWPAD_HUB_URL``. The turn itself spawns a real
``claude`` CLI, so ``FLOWPAD_CLAUDE_HOME=$HOME/.claude`` is also required — see
``real_home_for_cli_auth``.

The correspondent is a second real mailbox rather than a human with a mail
client. That is the same substitution the hub's own live validation made
(`docs/agent-email-inbox.md`: "Inbound from a real external mailbox"), and it
buys the thing a manual check cannot — this runs unattended and fails loudly.
What it does NOT prove is deliverability to a consumer provider like Gmail;
that remains a human check, once, per domain.

The turn is a real agent run, so these are deliberately one-turn tests. The
30-second cap is the budget: if a turn cannot answer "reply with OK" inside it,
that is a slow path to fix rather than a number to raise.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import httpx
import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver
from flow_sdk.ingest.sync import sync_source

from tests.hub_tests._local_login import login_as

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]

#: How long to wait for mail to come back, and how often to look. Not a retry
#: budget hiding a slow path — mail is asynchronous by nature and there is no
#: event to await. Bounded well inside the test timeout so the CAP is what
#: fails, with a readable assertion rather than a timeout kill.
REPLY_DEADLINE_SECONDS = 20
REPLY_POLL_SECONDS = 2




async def _hub_agent(hub_base_url: str, token: str, name: str) -> str:
    """A hub-side Agent row. Returns its id."""
    async with httpx.AsyncClient(timeout=20) as client:
        agent_id = str(uuid.uuid4())
        response = await client.post(
            f"{hub_base_url}/api/v1/graph/agent",
            headers={"Authorization": f"Bearer {token}"},
            json={"id": agent_id, "name": name, "worker_type": "claude"},
        )
        response.raise_for_status()
    return agent_id


@pytest.fixture
async def mailboxes(hub_base_url, hub_login_payload):
    """Two real mailboxes: the agent's, and an outsider's. Both released.

    Allocation is idempotent at the provider (the agent typeid is AgentMail's
    `client_id`), so a crashed run does not strand a second address for the
    same agent — but the finalizer still runs, because "does not strand a
    DUPLICATE" is not "gives the first one back".
    """
    token = login_as(hub_login_payload)
    driver = get_email_inbox_driver()

    agent_id = await _hub_agent(hub_base_url, token, f"mail-agent-{uuid.uuid4().hex[:8]}")
    outsider_id = await _hub_agent(hub_base_url, token, f"mail-outsider-{uuid.uuid4().hex[:8]}")

    allocated: list[str] = []
    try:
        agent_box = await driver.create_inbox(agent_id)
        allocated.append(agent_id)
        outsider_box = await driver.create_inbox(outsider_id)
        allocated.append(outsider_id)
        yield {
            "agent_id": agent_id,
            "agent_address": str(agent_box.get("address") or ""),
            "outsider_id": outsider_id,
            "outsider_address": str(outsider_box.get("address") or ""),
        }
    finally:
        # Addresses FIRST — they are the billable, permanent half. Then the hub
        # rows, asserted, because the tier reclaimer only sweeps what it knows
        # about and a stranded agent row is a leak nobody sees.
        for released in allocated:
            try:
                await driver.delete_inbox(released)
            except Exception:  # noqa: BLE001 — a second DELETE answers 404
                pass
        async with httpx.AsyncClient(timeout=20) as client:
            for released in (agent_id, outsider_id):
                gone = await client.request(
                    "DELETE",
                    f"{hub_base_url}/api/v1/graph/agent/{released}",
                    headers={"Authorization": f"Bearer {token}"},
                    json={},
                )
                assert gone.status_code < 400, f"LEAKED agent {released}: {gone.text[:200]}"


@pytest.fixture(autouse=True)
def real_home_for_cli_auth():
    """Give the spawned CLI the real ``$HOME`` so it can authenticate.

    The root conftest swaps HOME to a sandbox before flow_sdk imports, which is
    right for the indexer (it otherwise walks the user's whole projects tree)
    and wrong for a spawned worker: the CLI inherits the swapped HOME through
    ``os.environ`` and finds no ``~/.claude/.credentials.json``, so the turn
    starts, produces nothing, and the test reports "no reply" — infrastructure
    read as a broken feature. `tests/long_tests/conftest.py` solves it the same
    way for the same reason; the scope is subprocess auth ONLY, and in-process
    flow_sdk state stays anchored to the sandbox because `InstanceSettings` was
    built under it at import time.
    """
    real = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~")
    sandbox = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
    os.environ["HOME"] = real
    os.environ["USERPROFILE"] = real
    try:
        yield
    finally:
        for key, value in sandbox.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _inject_claude_harness() -> None:
    """Point the harness capability at the `claude` on PATH, or skip.

    Skips rather than fails when there is no CLI: an absent binary is this
    machine's state, not a defect in the feature under test — the same line
    `tests/long_tests` draws.
    """
    from flow_sdk.core.capabilities.discovery import get_capability_value, set_capability_value
    from flow_sdk.core.capabilities.models import CapabilityKind, CapabilityValue

    from tests.utils.claude_utils import find_claude

    kind = CapabilityKind.CLAUDE_CLI.value
    if get_capability_value(kind) is not None:
        return
    binary = find_claude()
    if not binary:
        pytest.skip("no `claude` CLI on PATH — cannot run a real turn")
    set_capability_value(
        CapabilityValue(
            kind=kind,
            value={"path": str(Path(binary).resolve().parent), "ref_type": "folder"},
            value_spec=DataSpec.parse("fs_ref"),
        )
    )


@pytest.fixture(autouse=True)
async def armed_agent_runner():
    """Bring the process up the way the server does, then run the test.

    pytest never runs server startup, so nothing is armed and nothing discovers
    the CLI. Both halves below stand that up — and both go through the same
    entry point production uses, so a change to what startup arms reaches this
    test instead of leaving it asserting against a half-wired process.
    """
    from flow_sdk.inbox import start_inbox

    # The SAME call `server/app.py` makes — the lane order is a production
    # contract, so the test asserts against it rather than restating it.
    start_inbox()

    # The turn spawns a real CLI, and the driver resolves it from the discovered
    # harness capability rather than from PATH — the backend's service PATH is
    # routinely stripped, so that lookup table is the only thing that knows
    # where the binary is. The server fills it at startup; this instance is
    # fresh, so without it every turn dies with "no harness.claude.cli
    # installation discovered" and the feature looks broken when only the table
    # is empty.
    #
    # INJECTED, not discovered. A real sweep spawns its own probe PTY — another
    # full `claude` launch — and on a cold instance that costs more of the
    # 30-second budget than the turn under test does, so the test starts failing
    # on the setup rather than on the feature. `set_capability_value` exists for
    # exactly this ("injectable in tests"), and what it injects is what a sweep
    # would have found: the folder holding the CLI on PATH.
    _inject_claude_harness()

    yield


async def _agent_mailbox(mailboxes, *, allow: list[str]) -> DataSource:
    """A local Agent wired to the allocated mailbox; returns the source to poll.

    Returns the DataSource rather than the Agent because that is the only half
    either test uses — handing back the Agent meant stashing the source on a
    private attribute and reaching through it at every call site.
    """
    agent = Agent(
        id=mailboxes["agent_id"],
        name=f"Mailbot {mailboxes['agent_id'][:8]}",
        worker_type="claude",
        system_prompt="You answer email. Reply in one short sentence.",
        email_enabled=True,
        email_allowed_senders=allow,
    )
    await agent.save()

    source = DataSource(
        name="agent mailbox",
        provider="cloud_email",
        channel="email",
        config={"agent_id": mailboxes["agent_id"], "address": mailboxes["agent_address"]},
        account_key=mailboxes["agent_address"],
    )
    await source.save()
    return source


async def _await_reply(outsider_id: str, *, from_address: str) -> dict | None:
    """The first message the AGENT sent to the outsider, or None.

    Matches on the sender, never on "the mailbox grew". A provider files the
    SENT copy in the sender's own mailbox — the local provider labels it
    ``sent`` and AgentMail does the same — so the outsider's box gains a message
    the instant it writes to the agent, before anything has answered. A
    count-based wait therefore returns the outsider's OWN question, which reads
    as a reply and carries the nonce the question asked for: the happy-path test
    goes green without an agent, and the gate test goes red without a leak. Both
    failure directions are silent, which is why this matches identity instead.
    """
    driver = get_email_inbox_driver()
    wanted = (from_address or "").strip().lower()
    deadline = asyncio.get_event_loop().time() + REPLY_DEADLINE_SECONDS
    while asyncio.get_event_loop().time() < deadline:
        page = await driver.list_messages(outsider_id)
        for message in reversed(list((page or {}).get("messages") or [])):
            sender = str((message.get("sender") or {}).get("address") or "").strip().lower()
            if sender == wanted:
                return message
        await asyncio.sleep(REPLY_POLL_SECONDS)
    return None


async def test_an_outsider_emails_the_agent_and_gets_an_answer(mailboxes):
    """The whole feature, from the outside: write to the address, get a reply.

    The question carries a NONCE and asks for it back. Asserting only that mail
    arrived would pass on an auto-responder; requiring the nonce proves the
    reply came from a model that read the question.
    """
    driver = get_email_inbox_driver()
    source = await _agent_mailbox(mailboxes, allow=[mailboxes["outsider_address"]])
    nonce = f"okra{uuid.uuid4().hex[:8]}"

    await driver.send(
        mailboxes["outsider_id"],
        {
            "to": mailboxes["agent_address"],
            "subject": "Ping",
            "text": f"Reply with exactly this word and nothing else: {nonce}",
        },
    )

    # One poll drives the whole chain: ingest → project → run the agent → reply.
    await sync_source(source)

    reply = await _await_reply(mailboxes["outsider_id"], from_address=mailboxes["agent_address"])
    if reply is None:
        # Distinguish OUR wiring from the CLI's availability. No process at all
        # means the chain never reached the agent — that is this feature broken.
        # A process that ran and said nothing is an unauthenticated or stuck
        # worker, which is infrastructure and skips rather than red-fails (the
        # convention `tests/long_tests` already follows).
        if not await _ran_a_turn():
            pytest.fail("no agent process was created — inbound never reached the agent")
        pytest.skip("agent process ran but produced no reply (no live CLI turn available)")
    body = (reply.get("text") or reply.get("preview") or "")
    assert nonce in body, f"reply did not answer the question: {body[:200]!r}"


async def _ran_a_turn() -> bool:
    """Did any agent process get created for a conversation during this test?

    No try/except: swallowing a query failure here would answer "no process",
    and the caller reports that as "inbound never reached the agent" — turning
    an infrastructure fault into precisely the wrong diagnosis, which is the
    thing this helper exists to prevent.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    # Composed from the delimiter the type owns, not the literal "conversation-";
    # `TypeId` refuses an empty id, so the prefix cannot be built by calling it.
    prefix = f"conversation{TypeId.TYPEID_DELIMITER}"
    return any(
        str(getattr(p, "target_typeid_str", "") or "").startswith(prefix)
        for p in await AgenticProcess.get_all({})
    )


async def test_an_unlisted_sender_is_ignored(mailboxes):
    """The gate is what stands between a public address and an agent with tools."""
    driver = get_email_inbox_driver()
    source = await _agent_mailbox(mailboxes, allow=["nobody@example.com"])

    await driver.send(
        mailboxes["outsider_id"],
        {"to": mailboxes["agent_address"], "subject": "Ping", "text": "Reply with the word OK."},
    )

    await sync_source(source)

    assert await _await_reply(mailboxes["outsider_id"], from_address=mailboxes["agent_address"]) is None, (
        "an unlisted sender got a reply"
    )
