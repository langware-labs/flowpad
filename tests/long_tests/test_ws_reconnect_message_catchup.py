"""A message sent while the hub socket is down must still reach the recipient.

The hub announces each FlowMessage exactly once, live, to whoever is connected
at that instant (``Conversation._fanout_message`` → ``notify_user_through_websocket``).
There is no replay and no ack. So the ONLY thing standing between a dropped
socket and a permanently lost message is what the client does when it comes
back up — and ``HubWebSocketManager._run_forever`` re-registers browser-context
watches without ever re-reading the conversations it was disconnected from.

In production that socket dies on a ~10-minute cadence
(``Hub WS listener closed: code=CloseCode.ABNORMAL_CLOSURE``), so every gap is a
window in which another user's message vanishes from this client's view until
the user happens to open that conversation.

Nothing here is mocked. Two real instances signed in as two real users against a
real hub; the disconnect is a REAL one — the recipient's process is stopped long
enough for the hub's own keepalive to drop the connection, which is the same
close the production log shows. The sender pushes through the real
``add_message`` action while that gap is open.

Requires the two-user rig (see CLAUDE.md → ``scripts/instance_ctl.sh``)::

    FLOWPAD_E2E_INSTANCE=<sender> FLOWPAD_E2E_PEER_INSTANCE=<recipient> pytest ...

and one conversation both users belong to.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from urllib.parse import urlsplit

import pytest
import requests

#: How long we allow the hub's keepalive to notice the frozen client and drop
#: the socket. NOT a tuning knob for flakiness — the test asserts the socket is
#: actually gone before it sends, and fails loudly if it never dropped.
SOCKET_DEATH_LIMIT_S = 120
#: How long the recipient gets, after resuming, to learn about the message by
#: ANY means. The bug is that no means exists; the fix makes it arrive in well
#: under a second.
DELIVERY_LIMIT_S = 90


def _conversations(port: int) -> dict[str, dict]:
    resp = requests.get(f"http://127.0.0.1:{port}/api/v1/graph/conversation", timeout=30)
    resp.raise_for_status()
    return {c["id"]: c for c in (resp.json().get("data") or []) if c.get("id")}


def _hub_socket_count(hub_port: int) -> int:
    """Established TCP connections to the hub, both endpoints counted."""
    out = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{hub_port}"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return sum(1 for line in out.splitlines() if "ESTABLISHED" in line)


def _has_message(port: int, fm_id: str) -> bool:
    try:
        resp = requests.get(f"http://127.0.0.1:{port}/api/v1/graph/flow_message/{fm_id}", timeout=15)
    except requests.RequestException:
        return False
    return bool(resp.ok and (resp.json().get("data") or {}).get("id"))


def _local_hub_for_pair(sender, recipient) -> tuple[str, int]:
    if sender.name == recipient.name:
        pytest.fail("FLOWPAD_E2E_INSTANCE and FLOWPAD_E2E_PEER_INSTANCE must be distinct")
    if not sender.hub_url or sender.hub_url != recipient.hub_url:
        pytest.fail("selected E2E instances must use the same non-empty Hub URL")

    parsed = urlsplit(sender.hub_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "localhost",
        "127.0.0.1",
        "::1",
    }:
        pytest.fail(f"selected E2E instances must use a local Hub, got {sender.hub_url!r}")
    try:
        hub_port = parsed.port
    except ValueError as exc:
        pytest.fail(f"selected E2E instances have an invalid Hub URL: {exc}")
    if hub_port is None:
        pytest.fail(f"selected E2E instances' Hub URL has no explicit port: {sender.hub_url!r}")
    return sender.hub_url, hub_port


@pytest.fixture()
def rig(resolve_live_e2e_instance) -> dict:
    sender = resolve_live_e2e_instance("FLOWPAD_E2E_INSTANCE")
    recipient = resolve_live_e2e_instance("FLOWPAD_E2E_PEER_INSTANCE")
    hub_url, hub_port = _local_hub_for_pair(sender, recipient)

    try:
        hub_response = requests.get(f"{hub_url}/api/v1/graph/bootstrap", timeout=10)
        hub_response.raise_for_status()
    except requests.RequestException as exc:
        pytest.fail(f"selected E2E rig's Hub is not reachable at {hub_url}: {exc}")

    try:
        shared = set(_conversations(sender.backend_port)) & set(_conversations(recipient.backend_port))
    except requests.RequestException as e:
        pytest.fail(f"selected E2E rig instance is not reachable: {e}")
    if not shared:
        pytest.fail(f"{sender.name} and {recipient.name} share no conversation")

    return {
        "sender": sender,
        "recipient": recipient,
        "hub_port": hub_port,
        "conversation_id": sorted(shared)[0],
    }


def test_message_sent_during_a_socket_gap_arrives_after_reconnect(rig):
    sender = rig["sender"]
    recipient = rig["recipient"]
    recipient_pid = recipient.backend_pid
    resumed = False

    # Freeze the recipient. Its process stays alive and its conversation stays
    # open — only the socket goes, exactly as it does in production.
    os.kill(recipient_pid, signal.SIGSTOP)
    try:
        baseline = _hub_socket_count(rig["hub_port"])
        deadline = time.monotonic() + SOCKET_DEATH_LIMIT_S
        while time.monotonic() < deadline and _hub_socket_count(rig["hub_port"]) >= baseline:
            time.sleep(2)
        assert _hub_socket_count(rig["hub_port"]) < baseline, (
            "the hub never dropped the frozen recipient's socket, so there is no gap to test"
        )

        # Real send, real action, while the recipient is unreachable.
        sent = requests.post(
            f"http://127.0.0.1:{sender.backend_port}/api/v1/graph/conversation/{rig['conversation_id']}/add_message",
            json={"text": "sent while the recipient's hub socket was down"},
            timeout=180,
        )
        sent.raise_for_status()
        payload = sent.json().get("data") or {}
        fm_id = payload.get("flow_message_id") or payload.get("id")
        assert fm_id, f"sender did not mint a message: {sent.text[:200]}"
        assert payload.get("delivery_status") == "sent", (
            f"hub did not accept the message, so its loss would prove nothing: {payload.get('delivery_status')}"
        )
    finally:
        os.kill(recipient_pid, signal.SIGCONT)
        resumed = True
    assert resumed

    deadline = time.monotonic() + DELIVERY_LIMIT_S
    while time.monotonic() < deadline:
        if _has_message(recipient.backend_port, fm_id):
            return
        time.sleep(2)

    pytest.fail(
        f"message {fm_id} never reached {recipient.name} in {DELIVERY_LIMIT_S}s after its socket "
        f"reconnected — the hub announced it once while the socket was down, and nothing "
        f"re-reads the conversation on reconnect, so it is lost until the user opens it"
    )
