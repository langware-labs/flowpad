"""The ``flow_conversation`` source's case in the data source matrix: one desk's team conversation holding a person's
message that tags the agent, so a sync lists one call; a send is the agent's free text into that conversation (the hub
is a double)."""

from __future__ import annotations

from contextlib import contextmanager

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.ingest.driver_registry import asset_module

DESK = mint_uuid()
ME = "agent-identity-matrix"


@contextmanager
def case(monkeypatch, tmp_path):
    source_module = asset_module("flow_conversation")
    monkeypatch.setattr(source_module, "_me", lambda: ME)

    async def call(method, entity_type, entity_id, action, sub_path=None, *, payload=None, **_kw):
        return {"id": mint_uuid(), "conversation_id": entity_id}

    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    monkeypatch.setattr(HubProxy, "call", staticmethod(call))

    async def prepare(_source_id: str) -> dict:
        from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
        from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

        conversation_id = mint_uuid()
        await Conversation(
            id=conversation_id, title=f"[ticket {mint_uuid()}] Matrix", kind="helpdesk_team", remote_project_id=DESK
        ).save(notify=False)
        fm = FlowMessage.model_validate(
            {
                "conversation_id": conversation_id,
                "text": "@agent are all 12 invoices in the cloud?",
                "sender_id": "user-matrix",
                "mentions": [ME],
                "remote": True,
            }
        )
        fm.id = mint_uuid()
        await fm.save(None, notify=False)
        return {"send": {"to": conversation_id, "thread_key": conversation_id, "text": "matrix send"}}

    yield {
        "config": {"desk_project_id": DESK},
        "min_items": 1,
        "prepare": prepare,
        "send": {"to": "set by prepare", "text": "matrix send"},
    }
