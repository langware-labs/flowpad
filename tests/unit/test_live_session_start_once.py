"""Two live-session starts at once (a double click) open one session, not two."""
import asyncio

import pytest

pytestmark = pytest.mark.timeout(10)

@pytest.mark.asyncio
async def test_two_quick_starts_open_one_session(monkeypatch):
    import flow_sdk.app.actions.execute_prompt as ep
    from flow_sdk.app.actions import notification_action as na
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession
    from flow_sdk.builtin.user import User

    conv = Conversation(title="repro")
    await conv.save(None)

    async def sender(_):
        return {"user_id": "guest-1", "name": "Eran"}
    async def emit(*a, **k):
        return None
    monkeypatch.setattr(User, "current_sender_participant", staticmethod(sender))
    monkeypatch.setattr(ep, "_peer_of", lambda c, s: ("host-1", "Ron", None))
    monkeypatch.setattr(ep, "emit_session_event", emit)

    body = {"reply_policy": "auto"}
    await asyncio.gather(
        na.handle_start_live_session(conv.id, dict(body), None),
        na.handle_start_live_session(conv.id, dict(body), None),
    )
    rows = await RemoteWorkerSession.get_all({"conversation_id": conv.id})
    assert len(rows) == 1
