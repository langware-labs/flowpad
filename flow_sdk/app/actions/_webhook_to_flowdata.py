"""Webhook payload -> generic FlowData translators (vendor-neutral wire layer).

Sister-file to ``cli_drivers/claude/hook_to_flowdata.py``. While that module
is Claude-hook-specific, this one handles the *other* webhook flavours
(``hook_op`` events) that pass through ``listen.py``.

After this layer, every webhook the backend dispatches arrives at the UI as
a canonical ``FlowData`` (``element-type=status``, ``source=sniffer``, plus a
``webhook-type``/``subtype`` discriminator) — regardless of original shape.
That removes the need for renderers to switch on ``hook_data.event_data`` vs
``hook_data.raw_hook_data`` or to cast through ``any`` to read trigger /
workflow / hook_op details.

Logger namespace: ``flow_sdk.app.actions._webhook_to_flowdata``.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataSource,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)


def convert_hook_op_event(payload: dict[str, Any]) -> list[FlowData]:
    """Map a hook_op webhook payload to a single ``FlowData`` item.

    ``payload`` is the dict ``_broadcast_to_sniffer`` / ``_route_to_source_process``
    receive for hook_op events — keys: ``webhook_type='hook_op'``, ``type``
    (record type), ``operation`` (CRUD / EVENT / INVOKE / LOG), ``id``,
    optional ``data``, ``execution_scope``.

    Surfaces hook_op-specific fields as canonical attributes:

    * ``hook-op-event-name`` — from ``data.event_name`` (hook_op events use
      this to discriminate, e.g. ``workflow_trace``, ``rules_executed``).
    * ``hook-op-operation`` — the hook_op operation kind.
    * ``hook-op-record-type`` — the entity type the op targets.
    * ``hook-op-id`` — the entity id.
    * ``workflow-label`` / ``workflow-phase`` — pulled from
      ``data.event_data`` when present (used by ``WorkflowTraceGutter`` to
      anchor events to ProseMirror blocks).

    Returns ``[]`` for structurally invalid payloads — never raises.
    """
    if not isinstance(payload, dict):
        return []

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    event_data = data.get("event_data") if isinstance(data.get("event_data"), dict) else {}

    event_name = str(data.get("event_name") or "")
    operation = str(payload.get("operation") or "")
    record_type = str(payload.get("type") or "")
    record_id = str(payload.get("id") or "")
    label = str(event_data.get("label") or "")
    phase = str(event_data.get("phase") or "")

    attributes: dict[str, str] = {
        "element-type": FlowElementType.STATUS,
        "data-type": FlowDataType.OBJECT,
        "source": FlowDataSource.SNIFFER,
        "webhook-type": "hook_op",
        "t": datetime.now(timezone.utc).isoformat(),
    }
    if event_name:
        attributes["subtype"] = event_name
        attributes["hook-op-event-name"] = event_name
    if operation:
        attributes["hook-op-operation"] = operation
    if record_type:
        attributes["hook-op-record-type"] = record_type
    if record_id:
        attributes["hook-op-id"] = record_id
    if label:
        attributes["workflow-label"] = label
    if phase:
        attributes["workflow-phase"] = phase

    return [FlowData(flow_value=payload, attributes=attributes)]


def convert_webhook_event(payload: dict[str, Any]) -> list[FlowData]:
    """Dispatch a webhook payload to the right translator based on ``webhook_type``.

    Single entry-point used by the legacy ``_broadcast_to_sniffer`` and
    ``_route_to_source_process`` helpers — they no longer need to construct
    ad-hoc ``FlowData`` themselves.
    """
    if not isinstance(payload, dict):
        return []
    webhook_type = payload.get("webhook_type")
    if webhook_type == "agent_hook":
        from flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata import (
            convert_hook_event,
        )
        return convert_hook_event(payload)
    if webhook_type == "hook_op":
        return convert_hook_op_event(payload)
    # Unknown webhook type — emit a minimal STATUS so the wire stays
    # continuous; downstream filters can drop it.
    return [
        FlowData(
            flow_value=payload,
            attributes={
                "element-type": FlowElementType.STATUS,
                "data-type": FlowDataType.OBJECT,
                "source": FlowDataSource.SNIFFER,
                "webhook-type": str(webhook_type or "unknown"),
                "t": datetime.now(timezone.utc).isoformat(),
            },
        )
    ]
