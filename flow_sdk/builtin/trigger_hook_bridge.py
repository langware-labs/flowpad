"""Runs Triggers when a hook fires — the one place the two layers meet.

Dependency direction is deliberate and one-way: **triggers may depend on hooks;
hooks may not depend on triggers.** ``agent_hook`` therefore knows nothing about
``Trigger``; this bridge imports both and subscribes an ``AgentHookCallback`` on
the hook side. Deleting this module would leave hooks fully functional — they
would simply stop firing rules, which is the correct blast radius for a layer
that sits above.

Pinned by ``tests/unit/test_hook_layering.py``.
"""

from __future__ import annotations

import logging

from flow_sdk.builtin.hook_models import ExecutedAction, HookEventData, WebhookHandleResult
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData

logger = logging.getLogger(__name__)


async def run_triggers_for_hook(hook, webhook_data: AgentHookData) -> WebhookHandleResult:
    """Invoke every Trigger connected to ``hook``; emit the bus envelopes.

    Two emissions, and the distinction matters:

    * ONE ``hook.<event>`` per inbound webhook, carrying the match count —
      emitted even when nothing matched, because a webhook that matches NOTHING
      is the common case and is otherwise invisible in the product.
    * ONE ``trigger.fired`` per MATCHED trigger, so a hook rule reads the same as
      a schedule or fsop rule on the events screen.

    No ``actor`` is stamped: a global hook is harness-wide, so the process that
    happened to fire it is not a meaningful principal.
    """
    from flow_sdk.builtin.trigger_on_tag import emit_hook_received, emit_trigger_fired

    hook_data = HookEventData(**webhook_data.hook_data)
    session_id = webhook_data.hook_data.get("session_id")

    executed_actions: list[ExecutedAction] = []
    matched_trigger_ids: list[str] = []

    for trigger in await hook.get_triggers():
        result = await trigger.invoke(hook_data)
        if not result:
            continue
        executed_actions.append(result)
        if trigger.id:
            matched_trigger_ids.append(trigger.id)
            emit_trigger_fired(
                trigger.id,
                str(trigger.trigger_type),
                trigger.name or trigger.id,
                counter=trigger.counter,
                action_types=[str(a.action_type) for a in trigger.actions],
                detail={
                    "hook_event": str(hook_data.hook_event_name or ""),
                    "agent_hook_id": hook.id,
                },
                project_id=trigger.project_id,
                scope_extra=[f"agent_hook:{hook.id}"] if hook.id else None,
            )

    emit_hook_received(
        hook.id or "",
        str(hook_data.hook_event_name or ""),
        matched=len(matched_trigger_ids),
        matched_trigger_ids=matched_trigger_ids,
        session_id=session_id,
    )

    return WebhookHandleResult(
        status="processed",
        matched_triggers=len(executed_actions),
        executed_actions=executed_actions,
        agentic_process_id=None,
        flow_id=None,
        session_id=session_id,
    )
