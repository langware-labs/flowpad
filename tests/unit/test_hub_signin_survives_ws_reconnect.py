"""A box the hub has named stays signed in when its hub socket drops and comes back.

Production drops the desktop's hub socket on a ~10-minute cadence (``Hub WS listener
closed: code=1006``). Funding reads "is this box signed in" from ``hub_ws_manager``'s
verification (``llm_source._hub_signed_in`` → ``core.status.hub_status``), and the
verification is asked only at boot. If a reconnect forgets it, every hub-funded LLM
endpoint is refused with "this box is not logged in to the hub" ten minutes after the
app starts -- observed on a tart VM where gadi+72's Begin allocation went ineligible
at the first reconnect after a manual verify.

Nothing in the manager is stubbed: a real local WebSocket server plays the hub (greets,
answers the "who am I" request), and the drop is a real abnormal close (transport abort).
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from websockets.asyncio.server import serve

from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _hub_signed_in
from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, save_credentials
from flow_sdk.cloud_client import ApiConfig
from flow_sdk.cloud_client.ws_client import hub_ws_manager

USER_ID = "7973e998-96b8-4b49-9ca6-25f4988fe192"


class _Hub:
    """The hub's WebSocket surface: greet every socket, name the user when asked.

    Also records the connection-status frames the manager publishes to the app's UI
    socket -- the manager's own "I am connected" announcement, made after it has set
    its state, so waiting on it never races the reconnect.
    """

    def __init__(self) -> None:
        self.main: list = []  # the manager's long-lived sockets, in connect order
        self.statuses: list[str] = []
        self.changed = asyncio.Condition()

    async def ui_broadcast(self, raw: str) -> None:
        msg = json.loads(raw)
        if msg.get("message_type") == "cloud_connection_status_msg":
            async with self.changed:
                self.statuses.append(msg.get("status"))
                self.changed.notify_all()

    async def handler(self, ws) -> None:
        await ws.send(json.dumps({"message_type": "ws_ready_msg"}))
        if hub_ws_manager._connection_id and ws.request.path.endswith(hub_ws_manager._connection_id):
            self.main.append(ws)
        async for raw in ws:
            if json.loads(raw).get("direct_resource_type") == "user":
                reply = {"status": "success", "data": {"id": USER_ID}}
                await ws.send(json.dumps({"message_type": "response_msg", "content": reply}))

    async def wait_up_after(self, mark: int) -> None:
        """Until the manager announces it is up again after status frame ``mark``."""
        async with self.changed:
            await self.changed.wait_for(lambda: any(s in ("connected", "verified") for s in self.statuses[mark:]))


@pytest.fixture()
async def hub(sod_env, monkeypatch):
    clear_user()
    save_credentials(UserHubCredentials(api_key="token", expires_at=time.time() + 3600, user={"id": USER_ID}))
    set_user({"id": USER_ID, "email": "gadi+72@langware.ai"})
    fake = _Hub()
    from flow_sdk.server.routes import websocket

    monkeypatch.setattr(websocket, "broadcast", fake.ui_broadcast)
    async with serve(fake.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(hub_ws_manager, "config", ApiConfig(api_base_url=f"http://127.0.0.1:{port}/api/v1"))
        monkeypatch.setattr(hub_ws_manager, "reconnect_initial_seconds", 0.0)
        yield fake
        await hub_ws_manager.stop()
    clear_user()


async def test_a_verified_box_stays_signed_in_across_a_hub_socket_reconnect(hub):
    # Boot, exactly as server/app.py does it: connect, then ask the hub who we are.
    await hub_ws_manager.start(wait_connected=True)
    await hub_ws_manager.verify_current_user()
    assert _hub_signed_in(), "precondition: the hub named the user at boot"

    # The production 10-minute drop: an abnormal close (1006), then the manager reconnects.
    mark = len(hub.statuses)
    hub.main[0].transport.abort()
    await hub.wait_up_after(mark)

    assert hub_ws_manager.is_connected
    assert _hub_signed_in(), (
        "the socket reconnected with the same credentials, yet the box is no longer signed in "
        f"(hub_ws_verified={hub_ws_manager.is_verified}, status={hub_ws_manager.status_payload().get('hub_ws_status')})"
    )
