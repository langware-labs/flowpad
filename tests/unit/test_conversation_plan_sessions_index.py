"""Plan sessions started before Implement Plan linked them onto the conversation (``PLAN_ROLE``) are found
once by ``index-plan-sessions`` — one SQL query over the thread's messages — and the stamp keeps the
conversation from being searched again. A process the conversation already gives a role keeps it."""

import json

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import notification_action as na
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.db.drivers.db_base_record import TypeId


def _fm(mid: str) -> TypeId:
    return TypeId(type="flow_message", id=mid)


async def test_old_plan_sessions_are_linked_once_and_a_session_role_is_kept():
    m1, m2, other = mint_uuid(), mint_uuid(), mint_uuid()
    conv = Conversation(title="c", message_ids=json.dumps([{"typeid": f"flow_message-{m}"} for m in (m1, m2)]))
    plan = await AgenticProcess(visible=True, shared_context_entities=[_fm(m2)]).save()
    hidden = await AgenticProcess(visible=False, shared_context_entities=[_fm(m1)]).save()
    elsewhere = await AgenticProcess(visible=True, shared_context_entities=[_fm(other)]).save()
    own = await AgenticProcess(visible=True, shared_context_entities=[_fm(m1)]).save()
    conv.add_shared_context_entities(TypeId(type="agentic_process", id=own.id), data=na.SESSION_ROLE)
    await conv.save()

    result = (await na.index_plan_sessions(conv)).data
    stored = await Conversation.get_by_id(conv.id)

    def role(proc):
        return stored.get_context_entry_data(TypeId(type="agentic_process", id=proc.id))

    assert result["linked"] == 1 and stored.plan_sessions_indexed_at is not None
    assert role(plan) == {**na.PLAN_ROLE, "message_id": m2}
    assert role(own) == na.SESSION_ROLE
    assert role(hidden) is None and role(elsewhere) is None

    # Stamped: a second call searches nothing, links nothing.
    await AgenticProcess(visible=True, shared_context_entities=[_fm(m1)]).save()
    assert (await na.index_plan_sessions(stored)).data["linked"] == 0
