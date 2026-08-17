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

    scripts/instance_ctl.sh launch wsa-5 --hub http://localhost:8093
    scripts/instance_ctl.sh launch wsb-6 --hub http://localhost:8093

and one conversation both users belong to.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import pytest
import requests

SENDER = "wsa-5"
RECIPIENT = "wsb-6"
HUB_PORT = 8093

#: How long we allow the hub's keepalive to notice the frozen client and drop
#: the socket. NOT a tuning knob for flakiness — the test asserts the socket is
#: actually gone before it sends, and fails loudly if it never dropped.
SOCKET_DEATH_LIMIT_S = 120
#: How long the recipient gets, after resuming, to learn about the message by
#: ANY means. The bug is that no means exists; the fix makes it arrive in well
#: under a second.
DELIVERY_LIMIT_S = 90


def _instance_port(name: str) -> int:
    server_json = Path.home() / ".flow" / "instances" / name / "server.json"
    if not server_json.exists():
        pytest.skip(f"instance {name!r} is not running (no server.json)")
    return int(json.loads(server_json.read_text())["port"])


def _instance_pid(name: str) -> int:
    pid_file = Path.home() / ".flow" / "instances" / name / "server.pid"
    if not pid_file.exists():
        pytest.skip(f"instance {name!r} has no server.pid")
    return int(pid_file.read_text().strip())


def _conversations(port: int) -> dict[str, dict]:
    resp = requests.get(f"http://127.0.0.1:{port}/api/v1/graph/conversation", timeout=30)
    resp.raise_for_status()
    return {c["id"]: c for c in (resp.json().get("data") or []) if c.get("id")}


def _hub_socket_count() -> int:
    """Established TCP connections to the hub, both endpoints counted."""
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{HUB_PORT}"], capture_output=True, text=True, check=False).stdout
    return sum(1 for line in out.splitlines() if "ESTABLISHED" in line)


def _has_message(port: int, fm_id: str) -> bool:
    try:
        resp = requests.get(f"http://127.0.0.1:{port}/api/v1/graph/flow_message/{fm_id}", timeout=15)
    except requests.RequestException:
        return False
    return bool(resp.ok and (resp.json().get("data") or {}).get("id"))


@pytest.fixture()
def rig() -> dict:
    try:
        hub_ok = requests.get(f"http://127.0.0.1:{HUB_PORT}/api/v1/graph/bootstrap", timeout=10).ok
    except requests.RequestException:
        hub_ok = False
    if not hub_ok:
        pytest.skip(f"local hub is not serving on :{HUB_PORT}")

    sender_port, recipient_port = _instance_port(SENDER), _instance_port(RECIPIENT)
    try:
        shared = set(_conversations(sender_port)) & set(_conversations(recipient_port))
    except requests.RequestException as e:
        pytest.skip(f"rig instance not reachable: {e}")
    if not shared:
        pytest.skip(f"{SENDER} and {RECIPIENT} share no conversation")

    return {
        "sender_port": sender_port,
        "recipient_port": recipient_port,
        "recipient_pid": _instance_pid(RECIPIENT),
        "conversation_id": sorted(shared)[0],
    }


def test_message_sent_during_a_socket_gap_arrives_after_reconnect(rig):
    recipient_pid = rig["recipient_pid"]
    resumed = False

    # Freeze the recipient. Its process stays alive and its conversation stays
    # open — only the socket goes, exactly as it does in production.
    os.kill(recipient_pid, signal.SIGSTOP)
    try:
        baseline = _hub_socket_count()
        deadline = time.monotonic() + SOCKET_DEATH_LIMIT_S
        while time.monotonic() < deadline and _hub_socket_count() >= baseline:
            time.sleep(2)
        assert _hub_socket_count() < baseline, (
            "the hub never dropped the frozen recipient's socket, so there is no gap to test"
        )

        # Real send, real action, while the recipient is unreachable.
        sent = requests.post(
            f"http://127.0.0.1:{rig['sender_port']}/api/v1/graph/conversation/{rig['conversation_id']}/add_message",
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
        if _has_message(rig["recipient_port"], fm_id):
            return
        time.sleep(2)

    pytest.fail(
        f"message {fm_id} never reached {RECIPIENT} in {DELIVERY_LIMIT_S}s after its socket "
        f"reconnected — the hub announced it once while the socket was down, and nothing "
        f"re-reads the conversation on reconnect, so it is lost until the user opens it"
    )
